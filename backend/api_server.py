# backend/api_server.py
import os
import sqlite3
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Depends, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from auth_utils import verify_password, create_access_token, decode_token

# -----------------------------
# ENV (load database.env explicitly)
# -----------------------------
ENV_PATH = Path(__file__).resolve().parent / "database.env"
load_dotenv(dotenv_path=ENV_PATH)

app = FastAPI()
print("### LOADED api_server.py ###")

# -----------------------------
# CORS
# -----------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5500", "http://localhost:5500"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------
# Database configuration
# -----------------------------
DEFAULT_DB = Path(__file__).resolve().parent.parent / "database" / "ABCDEF.db"
DB_PATH = Path(os.getenv("EURCOM_DB_PATH", str(DEFAULT_DB))).expanduser().resolve()


def get_conn() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise RuntimeError(f"Database not found: {DB_PATH}")
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn

def get_table_columns(conn, table_name: str) -> list[str]:
    """
    Returns a list of column names for a given table.
    If the table does not exist, returns an empty list.
    """
    try:
        cursor = conn.cursor()
        cursor.execute(f"PRAGMA table_info({table_name})")
        rows = cursor.fetchall()
        return [row[1] for row in rows]  # row[1] = column name
    except Exception as e:
        print(f"[WARN] get_table_columns failed for {table_name}: {e}")
        return []

def row_to_dict(r: sqlite3.Row) -> dict:
    return dict(r)


@app.get("/api/health")
def health():
    return {"ok": True, "dbPath": str(DB_PATH)}

# -----------------------------
# Auth endpoints
# -----------------------------
@app.post("/api/auth/login")
def login(payload: dict):
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""

    if not username or not password:
        raise HTTPException(status_code=400, detail="Missing username or password")

    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, username, password_hash, role, customer_id, is_active
            FROM ecs_users
            WHERE username = ?
            """,
            (username,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="Invalid credentials")

        if not row["is_active"]:
            raise HTTPException(status_code=403, detail="User disabled")

        if not verify_password(password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid credentials")

        cur.execute(
            "UPDATE ecs_users SET last_login_at = datetime('now') WHERE id = ?",
            (row["id"],),
        )
        conn.commit()

        token = create_access_token(
            sub=row["username"], role=row["role"], user_id=row["id"]
        )
        return {
            "access_token": token,
            "token_type": "bearer",
            "user": {
                "id": row["id"],
                "username": row["username"],
                "role": row["role"],
                "customer_id": row["customer_id"],
            },
        }
    finally:
        conn.close()


def get_current_user(authorization: str = Header(default="")):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    token = authorization.replace("Bearer ", "", 1).strip()
    try:
        claims = decode_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    uid = claims.get("uid")
    if uid is None:
        raise HTTPException(status_code=401, detail="Invalid token")

    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, username, role, customer_id, is_active FROM ecs_users WHERE id = ?",
            (uid,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="User not found")
        if not row["is_active"]:
            raise HTTPException(status_code=403, detail="User disabled")

        return {
            "id": row["id"],
            "username": row["username"],
            "role": row["role"],
            "customer_id": row["customer_id"],
        }
    finally:
        conn.close()


@app.get("/api/me")
def me(user=Depends(get_current_user)):
    return user


# -----------------------------
# Role guards
# -----------------------------
def require_employee(user=Depends(get_current_user)):
    if user["role"] not in ("EMPLOYEE", "ADMIN"):
        raise HTTPException(status_code=403, detail="Employee access required")
    return user


def require_customer(user=Depends(get_current_user)):
    if user["role"] != "CUSTOMER":
        raise HTTPException(status_code=403, detail="Customer access required")
    return user


# -----------------------------
# Employee-only endpoints
# -----------------------------
@app.get("/api/customers")
def get_customers(user=Depends(require_employee)):
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT DISTINCT customer_id
            FROM ecs_customer_rpt
            ORDER BY customer_id
            """
        )
        rows = cur.fetchall()
        return [{"customer_id": r["customer_id"]} for r in rows]
    finally:
        conn.close()


@app.get("/api/customers/{customer_id}")
def get_customer(customer_id: int, user=Depends(require_employee)):
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT *
            FROM ecs_customer_rpt
            WHERE customer_id = ?
            ORDER BY run_id DESC
            LIMIT 1
            """,
            (customer_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Customer report not found")
        return row_to_dict(row)
    finally:
        conn.close()


# -----------------------------
# Customer secure endpoint
# -----------------------------

# -----------------------------
# Employee-only customer search (fast, no report rendering)
# -----------------------------


@app.get("/api/customers/search")
def search_customers(
    q: str | None = None,
    tier: str | None = None,
    customer_id: str | None = None,
    name: str | None = None,
    surname: str | None = None,
    limit: int = 25,
    offset: int = 0,
    user=Depends(require_employee),
):
    """Lightweight customer search for 100K+ records.
    Returns ONLY identity fields (no report payload), so the UI doesn't trigger heavy rendering.
    """
    conn = get_conn()
    try:
        cols = get_table_columns(conn, "ecs_customers")
        have_customers = bool(cols)

        where = []
        params = {}

        # If we have ecs_customers with identity columns, prefer it.
        if have_customers and {"customer_id"}.issubset(cols):
            # allow optional fields if present
            if tier and "tier" in cols:
                where.append("ec.tier = :tier")
                params["tier"] = tier

            if customer_id:
                where.append("CAST(ec.customer_id AS TEXT) = :customer_id")
                params["customer_id"] = str(customer_id).strip()

            if name and "name" in cols:
                where.append("LOWER(ec.name) LIKE LOWER(:name)")
                params["name"] = f"%{name.strip()}%"

            if surname and "surname" in cols:
                where.append("LOWER(ec.surname) LIKE LOWER(:surname)")
                params["surname"] = f"%{surname.strip()}%"

            if q:
                qv = q.strip()
                # match by id exact OR name/surname partial (if available)
                parts = ["CAST(ec.customer_id AS TEXT) = :q_exact"]
                params["q_exact"] = qv
                params["q_like"] = f"%{qv}%"
                if "name" in cols:
                    parts.append("LOWER(ec.name) LIKE LOWER(:q_like)")
                if "surname" in cols:
                    parts.append("LOWER(ec.surname) LIKE LOWER(:q_like)")
                where.append("(" + " OR ".join(parts) + ")")

            where_sql = ("WHERE " + " AND ".join(where)) if where else ""
            sql = f"""
                SELECT
                    ec.customer_id,
                    { "ec.name" if "name" in cols else "NULL AS name" },
                    { "ec.surname" if "surname" in cols else "NULL AS surname" },
                    { "ec.tier" if "tier" in cols else "NULL AS tier" }
                FROM ecs_customers ec
                {where_sql}
                ORDER BY
                    { "ec.surname" if "surname" in cols else "ec.customer_id" } ASC,
                    { "ec.name" if "name" in cols else "ec.customer_id" } ASC
                LIMIT :limit OFFSET :offset
            """
        else:
            # Fallback: search only by customer_id from reports table (still lightweight).
            if customer_id:
                where.append("CAST(customer_id AS TEXT) = :customer_id")
                params["customer_id"] = str(customer_id).strip()
            elif q:
                where.append("CAST(customer_id AS TEXT) LIKE :q_like")
                params["q_like"] = f"%{q.strip()}%"
            else:
                # avoid returning all 100K rows accidentally
                return {"items": [], "limit": limit, "offset": offset}

            where_sql = ("WHERE " + " AND ".join(where)) if where else ""
            sql = f"""
                SELECT DISTINCT customer_id, NULL AS name, NULL AS surname, NULL AS tier
                FROM ecs_customer_rpt
                {where_sql}
                ORDER BY customer_id ASC
                LIMIT :limit OFFSET :offset
            """

        params["limit"] = int(limit)
        params["offset"] = int(offset)

        cur = conn.cursor()
        cur.execute(sql, params)
        rows = cur.fetchall()
        # rows may be sqlite3.Row
        items = [
            (
                row_to_dict(r)
                if hasattr(r, "keys")
                else {"customer_id": r[0], "name": r[1], "surname": r[2], "tier": r[3]}
            )
            for r in rows
        ]
        return {"items": items, "limit": params["limit"], "offset": params["offset"]}
    finally:
        conn.close()


@app.get("/api/customers/balance-tiers")
def customer_balance_tiers(user=Depends(require_employee)):
    """Tier split based on the provided SQL (Customers_Ordering.sql)."""
    conn = get_conn()
    try:
        cur = conn.cursor()
        sql = f"""
        SELECT
            ea.status,
            ea.account_type,
            {BALANCE_TIER_CASE} AS BalanceClassificatons,
            COUNT(DISTINCT ec.customer_id) AS Customers,
            COUNT(DISTINCT ea.account_id) AS Accounts
        FROM ecs_customers ec
        INNER JOIN ecs_accounts ea ON ec.customer_id = ea.customer_id
        GROUP BY
            ea.status,
            ea.account_type,
            {BALANCE_TIER_CASE}
        ORDER BY
            BalanceClassificatons, ea.status, ea.account_type
        """
        cur.execute(sql)
        rows = cur.fetchall()
        return {"items": [row_to_dict(r) for r in rows]}
    finally:
        conn.close()


@app.get("/api/customers/by-balance-tier")
def customers_by_balance_tier(
    tier: str,
    status: str | None = None,
    account_type: str | None = None,
    limit: int = 50,
    offset: int = 0,
    user=Depends(require_employee),
):
    """List customers that fall into a given BalanceClassificatons tier."""
    conn = get_conn()
    try:
        where = [f"{BALANCE_TIER_CASE} = :tier"]
        params = {"tier": tier, "limit": int(limit), "offset": int(offset)}

        if status:
            where.append("ea.status = :status")
            params["status"] = status
        if account_type:
            where.append("ea.account_type = :account_type")
            params["account_type"] = account_type

        where_sql = " AND ".join(where)

        cur = conn.cursor()
        cur.execute(
            f"""
            SELECT
                ec.customer_id,
                ec.name,
                ec.surname,
                ea.account_id,
                ea.status,
                ea.account_type,
                ea.balance,
                {BALANCE_TIER_CASE} AS BalanceClassificatons
            FROM ecs_customers ec
            INNER JOIN ecs_accounts ea ON ec.customer_id = ea.customer_id
            WHERE {where_sql}
            ORDER BY ec.surname ASC, ec.name ASC
            LIMIT :limit OFFSET :offset
            """,
            params,
        )
        rows = cur.fetchall()
        return {
            "items": [row_to_dict(r) for r in rows],
            "limit": params["limit"],
            "offset": params["offset"],
        }
    finally:
        conn.close()


@app.get("/api/customer/reports")
def get_my_reports(user=Depends(require_customer)):
    customer_id = user.get("customer_id")
    if customer_id is None:
        raise HTTPException(status_code=400, detail="Missing customer_id for this user")

    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT *
            FROM ecs_customer_rpt
            WHERE customer_id = ?
            ORDER BY run_id DESC
            """,
            (customer_id,),
        )
        rows = cur.fetchall()
        return [row_to_dict(r) for r in rows]
    finally:
        conn.close()


# -----------------------------
# Debug endpoint
# -----------------------------
@app.get("/api/debug/customer-report-sample")
def debug_customer_report_sample(user=Depends(require_customer)):
    customer_id = user.get("customer_id")
    if customer_id is None:
        raise HTTPException(status_code=400, detail="Missing customer_id for this user")

    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT *
            FROM ecs_customer_rpt
            WHERE customer_id = ?
            ORDER BY run_id DESC
            LIMIT 1
            """,
            (customer_id,),
        )
        row = cur.fetchone()
        if not row:
            return {"ok": True, "customer_id": customer_id, "message": "No rows"}

        data = row_to_dict(row)
        preview = {}
        for k, v in data.items():
            if isinstance(v, (str, bytes)) and v is not None and len(v) > 300:
                preview[k] = f"<{type(v).__name__} length={len(v)}>"
            else:
                preview[k] = v

        return {"ok": True, "columns": list(data.keys()), "preview": preview}
    finally:
        conn.close()
