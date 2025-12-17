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

        cur.execute("UPDATE ecs_users SET last_login_at = datetime('now') WHERE id = ?", (row["id"],))
        conn.commit()

        token = create_access_token(sub=row["username"], role=row["role"], user_id=row["id"])
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


def get_current_user(authorization: str=Header(default="")):
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

