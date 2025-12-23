# backend/api_server.py
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware

from auth_utils import create_access_token, decode_token, verify_password

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
    allow_origins=[],
    allow_origin_regex=r"http://(127\.0\.0\.1|localhost)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------
# Database configuration
# -----------------------------
DEFAULT_DB = Path(__file__).resolve().parent.parent / "database" / "MCH_DB.db"
DB_PATH = Path(os.getenv("EURCOM_DB_PATH", str(DEFAULT_DB))).expanduser().resolve()


def get_conn() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise RuntimeError(f"Database not found: {DB_PATH}")
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def rows_to_dicts(rows: List[sqlite3.Row]) -> List[Dict[str, Any]]:
    return [row_to_dict(r) for r in rows]


def get_table_columns(conn: sqlite3.Connection, table_name: str) -> List[str]:
    try:
        cur = conn.cursor()
        cur.execute(f"PRAGMA table_info({table_name})")
        rows = cur.fetchall()
        return [r[1] for r in rows]
    except Exception as e:
        print(f"[WARN] get_table_columns failed for {table_name}: {e}")
        return []


def table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    cur = conn.cursor()
    cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        (table_name,),
    )
    return cur.fetchone() is not None


def list_tables(conn: sqlite3.Connection) -> List[str]:
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    return [r[0] for r in cur.fetchall()]


def count_rows(conn: sqlite3.Connection, table_name: str) -> int:
    try:
        cur = conn.cursor()
        cur.execute(f"SELECT COUNT(*) AS c FROM {table_name}")
        r = cur.fetchone()
        return int(r["c"]) if r else 0
    except Exception:
        return 0


def count_distinct_customer_id(
    conn: sqlite3.Connection, table_name: str, col: str
) -> int:
    try:
        cur = conn.cursor()
        cur.execute(f"SELECT COUNT(DISTINCT {col}) AS c FROM {table_name}")
        r = cur.fetchone()
        return int(r["c"]) if r else 0
    except Exception:
        return 0


# -----------------------------
# Health + routes
# -----------------------------
@app.get("/api/health")
def health():
    return {"ok": True, "db_path": str(DB_PATH)}


@app.get("/api/routes")
def routes():
    """Quick sanity check to confirm which api_server.py is running."""
    out = []
    for r in app.routes:
        methods = getattr(r, "methods", None)
        path = getattr(r, "path", None)
        name = getattr(r, "name", None)
        if path and methods:
            out.append({"methods": sorted(list(methods)), "path": path, "name": name})
    out.sort(key=lambda x: x["path"])
    return {"routes": out}


# -----------------------------
# Auth
# -----------------------------
@app.post("/api/auth/login")
def login(payload: Dict[str, Any]):
    username = (payload or {}).get("username")
    password = (payload or {}).get("password")

    if not username or not password:
        raise HTTPException(status_code=400, detail="Missing username/password")

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
        return {"access_token": token, "token_type": "bearer"}
    finally:
        conn.close()


def get_current_user(
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    token = authorization.split(" ", 1)[1].strip()
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


def require_employee(user=Depends(get_current_user)):
    if user["role"] not in ("EMPLOYEE", "ADMIN"):
        raise HTTPException(status_code=403, detail="Employee access required")
    return user


def require_customer(user=Depends(get_current_user)):
    if user["role"] != "CUSTOMER":
        raise HTTPException(status_code=403, detail="Customer access required")
    return user


# -----------------------------
# Customer source detection (NO hardcoding)
# -----------------------------
def pick_best_customer_source(conn: sqlite3.Connection) -> Tuple[str, str]:
    # Prefer ecs_customers if populated
    if table_exists(conn, "ecs_customers"):
        cols = {c.lower(): c for c in get_table_columns(conn, "ecs_customers")}
        if "customer_id" in cols and count_rows(conn, "ecs_customers") > 0:
            return ("ecs_customers", cols["customer_id"])

    # Scan all tables with customer_id and pick max distinct
    candidates: List[Tuple[str, str, int]] = []
    for t in list_tables(conn):
        cols = get_table_columns(conn, t)
        if not cols:
            continue
        lower = {c.lower(): c for c in cols}
        if "customer_id" not in lower:
            continue
        col = lower["customer_id"]
        dcount = count_distinct_customer_id(conn, t, col)
        if dcount > 0:
            candidates.append((t, col, dcount))

    if not candidates:
        raise HTTPException(
            status_code=500,
            detail="No table found with a populated customer_id column.",
        )

    candidates.sort(key=lambda x: x[2], reverse=True)
    return (candidates[0][0], candidates[0][1])


# -----------------------------
# Customers list (employee-only)
# -----------------------------
@app.get("/api/customers")
def list_customers(
    limit: int = Query(default=1000, ge=1, le=50000),
    offset: int = Query(default=0, ge=0),
    user=Depends(require_employee),
):
    conn = get_conn()
    try:
        source_table, cid_col = pick_best_customer_source(conn)
        cur = conn.cursor()

        # If the best table is ecs_customers, include names if possible
        if source_table == "ecs_customers":
            cols = {c.lower(): c for c in get_table_columns(conn, "ecs_customers")}
            first = cols.get("first_name") or cols.get("name")
            last = cols.get("last_name") or cols.get("surname")

            select_cols = [f"{cid_col} AS customer_id"]
            select_cols.append(
                f"{first} AS first_name" if first else "NULL AS first_name"
            )
            select_cols.append(f"{last} AS last_name" if last else "NULL AS last_name")

            order_by = "ORDER BY customer_id ASC"
            if last and first:
                order_by = "ORDER BY last_name ASC, first_name ASC"
            elif last:
                order_by = "ORDER BY last_name ASC"
            elif first:
                order_by = "ORDER BY first_name ASC"

            sql = f"""
                SELECT {", ".join(select_cols)}
                FROM {source_table}
                {order_by}
                LIMIT :limit OFFSET :offset
            """
            cur.execute(sql, {"limit": limit, "offset": offset})
            items = rows_to_dicts(cur.fetchall())
            return {
                "items": items,
                "limit": limit,
                "offset": offset,
                "source": source_table,
            }

        # Generic distinct listing
        sql = f"""
            SELECT DISTINCT {cid_col} AS customer_id
            FROM {source_table}
            ORDER BY customer_id
            LIMIT :limit OFFSET :offset
        """
        cur.execute(sql, {"limit": limit, "offset": offset})
        items = rows_to_dicts(cur.fetchall())
        return {
            "items": items,
            "limit": limit,
            "offset": offset,
            "source": source_table,
        }
    finally:
        conn.close()


# -----------------------------
# Employee-only: customer latest report
# -----------------------------
@app.get("/api/customers/{customer_id}")
def get_customer_latest_report(customer_id: str, user=Depends(require_employee)):
    conn = get_conn()
    try:
        if not table_exists(conn, "ecs_customer_rpt"):
            raise HTTPException(
                status_code=500,
                detail="Table ecs_customer_rpt not found. Use /api/debug/customers-sources to identify the correct report table.",
            )

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
# Customer: my reports
# -----------------------------
@app.get("/api/customer/reports")
def get_my_reports(user=Depends(require_customer)):
    customer_id = user.get("customer_id")
    if customer_id is None:
        raise HTTPException(status_code=400, detail="Missing customer_id for this user")

    conn = get_conn()
    try:
        if not table_exists(conn, "ecs_customer_rpt"):
            raise HTTPException(
                status_code=500, detail="Table ecs_customer_rpt not found"
            )

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
        return rows_to_dicts(cur.fetchall())
    finally:
        conn.close()


# -----------------------------
# Debug: discover sources
# -----------------------------
@app.get("/api/debug/customers-sources")
def debug_customers_sources(user=Depends(require_employee)):
    conn = get_conn()
    try:
        all_tables = list_tables(conn)
        with_customer_id = []
        for t in all_tables:
            cols = get_table_columns(conn, t)
            lower = {c.lower(): c for c in cols}
            if "customer_id" in lower:
                col = lower["customer_id"]
                with_customer_id.append(
                    {
                        "table": t,
                        "customer_id_col": col,
                        "rows": count_rows(conn, t),
                        "distinct_customer_id": count_distinct_customer_id(
                            conn, t, col
                        ),
                    }
                )

        chosen_table, chosen_col = pick_best_customer_source(conn)
        with_customer_id.sort(key=lambda x: x["distinct_customer_id"], reverse=True)

        return {
            "db_path": str(DB_PATH),
            "chosen": {"table": chosen_table, "customer_id_col": chosen_col},
            "tables_with_customer_id": with_customer_id,
        }
    finally:
        conn.close()
