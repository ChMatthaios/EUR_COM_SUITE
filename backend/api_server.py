from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import sqlite3
import json

DB_PATH = r"C:\Users\mchou\Desktop\Matthaios MatCho Chouliaras\EUR_COM_SUITE\database\MCH_DB.db"

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def latest_run_id(conn):
    r = conn.execute("SELECT MAX(run_id) AS run_id FROM ecs_rpt_runs").fetchone()
    return r["run_id"]


@app.get("/api/customers")
def customers():
    conn = get_conn()
    rid = latest_run_id(conn)
    rows = conn.execute("""
        SELECT customer_id
        FROM ecs_customer_rpt
        WHERE run_id = ?
        ORDER BY customer_id
        LIMIT 10000
    """, (rid,)).fetchall()
    conn.close()
    return [{"customerId": r["customer_id"]} for r in rows]


@app.get("/api/customers/{customer_id}")
def customer_report(customer_id: int):
    conn = get_conn()
    rid = latest_run_id(conn)
    row = conn.execute("""
        SELECT customer_id, json_doc, xml_doc, generated_at
        FROM ecs_customer_rpt
        WHERE run_id = ? AND customer_id = ?
    """, (rid, customer_id)).fetchone()
    conn.close()

    if not row:
        return {"error": "not found", "customerId": customer_id}

    try:
        final_json = json.loads(row["json_doc"])
    except Exception:
        final_json = row["json_doc"]

    return {
        "customerId": row["customer_id"],
        "extractionDate": row["generated_at"],
        "finalJson": final_json,
        "finalXml": row["xml_doc"],
    }
