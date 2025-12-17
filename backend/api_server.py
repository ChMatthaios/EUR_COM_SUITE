"""
EUR_COM_SUITE backend API (FastAPI)

Features:
- JWT login (/api/auth/login) + session endpoint (/api/me)
- Role-based access control:
    - EMPLOYEE/ADMIN can list customers + view any customer's latest report
    - CUSTOMER can only access their own reports
- Customer secure endpoint: /api/customer/reports (customer_id comes from JWT)
- Debug endpoint (customer-only): /api/debug/customer-report-sample
"""

import os
import sqlite3
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Depends, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from auth_utils import verify_password, create_access_token, decode_token

# IMPORTANT:
# We explicitly load backend/.env so you can keep env config next to backend.
ENV_PATH = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=ENV_PATH)

app = FastAPI()
print("### LOADED api_server.py ###")

# CORS: allow the static frontend (python http.server / VSCode live server) to call this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------
# Database configuration
# -----------------------------
# Default DB path if EURCOM_DB_PATH isn't set
DEFAULT_DB = Path(__file__).resolve().parent.parent / "database" / "MCH_DB.db"

# Read DB path from env; fall back to default
DB_PATH = Path(os.getenv("EURCOM_DB_PATH", str(DEFAULT_DB))).expanduser().resolve()


def get_conn() -> sqlite3.Connection:
    """Open a SQLite connection. (Remember: close it in finally blocks.)"""
    conn = sqlite3.connect(str(DB_PATH))
    # We return tuples and build dicts manually to avoid hidden magic
    conn.row_factory = None
    return conn


@app.get("/api/health")
def health():
    return {"ok": True, "dbPath": str(DB_PATH)}


# -----------------------------
# Auth endpoints
# -----------------------------
@app.post("/api/auth/login")
def login(payload: dict):
    """
    Login with username/password.
    Returns:
      { access_token, token_type, user: {id, username, role, customer_id} }
    """
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

        user_id, uname, password_hash, role, customer_id, is_active = row

        if not is_active:
            raise HTTPException(status_code=403, detail="User disabled")

        if not verify_password(password, password_hash):
            raise HTTPException(status_code=401, detail="Invalid credentials")

        cur.execute("UPDATE ecs_users SET last_login_at = datetime('now') WHERE id = ?", (user_id,))
        conn.commit()

        token = create_access_token(sub=uname, role=role, user_id=user_id)
        return {
            "access_token": token,
            "token_type": "bearer",
            "user": {"id": user_id, "username": uname, "role": role, "customer_id": customer_id},
        }
    finally:
        conn.close()


def get_current_user(authorization: str=Header(default="")):
    """
    Read Bearer token from Authorization header and return the current user (fresh from DB).
    """
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

        user_id, uname, role, customer_id, is_active = row
        if not is_active:
            raise HTTPException(status_code=403, detail="User disabled")

        return {"id": user_id, "username": uname, "role": role, "customer_id": customer_id}
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
    """
    Employee/Admin: list all customers available in ecs_customer_rpt.
    """
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
        return [{"customer_id": r[0]} for r in rows]
    finally:
        conn.close()


@app.get("/api/customers/{customer_id}")
def get_customer(customer_id: int, user=Depends(require_employee)):
    """
    Employee/Admin: get latest report row for a specific customer.
    IMPORTANT: uses ORDER BY run_id (your correct column name).
    """
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

        cols = [c[0] for c in cur.description]
        return dict(zip(cols, row))
    finally:
        conn.close()


# -----------------------------
# Customer secure endpoint
# -----------------------------
@app.get("/api/customer/reports")
def get_my_reports(user=Depends(require_customer)):
    """
    Customer: fetch ONLY own reports.
    Server derives customer_id from JWT (never from client input).
    """
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
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        return rows
    finally:
        conn.close()


# -----------------------------
# Debug endpoint (customer-only)
# -----------------------------
@app.get("/api/debug/customer-report-sample")
def debug_customer_report_sample(user=Depends(require_customer)):
    """
    Customer-only debug endpoint:
    Returns the column names + a safe preview of the latest report row.
    """
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

        cols = [c[0] for c in cur.description]
        data = dict(zip(cols, row))

        # Don't dump huge JSON/XML blobs; show their sizes instead
        preview = {}
        for k, v in data.items():
            if isinstance(v, (str, bytes)) and v is not None and len(v) > 300:
                preview[k] = f"<{type(v).__name__} length={len(v)}>"
            else:
                preview[k] = v

        return {"ok": True, "columns": cols, "preview": preview}
    finally:
        conn.close()
