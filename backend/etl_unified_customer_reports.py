import sqlite3
import json
from datetime import datetime, date, timezone
from xml.sax.saxutils import escape as xml_escape
from typing import Dict, List, Tuple, Optional

DB_PATH = r"C:/A/B/C/D/D/E/######.db"

# Must match what you generated in stage 1
MODULES = ["CUSTOMER_PROFILE", "ACCOUNTS", "TRANSACTIONS", "CARDS", "LOANS", "COMPLIANCE", "FEES"]

# performance / logging
PROGRESS_EVERY = 500
INSERT_CHUNK_SIZE = 500
SQLITE_TIMEOUT_SECONDS = 60


# -------------------------
# DB helpers
# -------------------------
def dict_rows(conn: sqlite3.Connection, sql: str, params: Tuple=()) -> List[Dict]:
    cur = conn.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def dict_row(conn: sqlite3.Connection, sql: str, params: Tuple=()) -> Optional[Dict]:
    cur = conn.execute(sql, params)
    row = cur.fetchone()
    if row is None:
        return None
    cols = [d[0] for d in cur.description]
    return dict(zip(cols, row))


def get_latest_run_id(conn: sqlite3.Connection) -> int:
    r = dict_row(conn, "SELECT run_id FROM ecs_rpt_runs ORDER BY run_id DESC LIMIT 1")
    if not r:
        raise SystemExit("No rows found in ecs_rpt_runs. Create a run first.")
    return int(r["run_id"])


def get_as_of_date(conn: sqlite3.Connection, run_id: int) -> str:
    r = dict_row(conn, "SELECT as_of_date FROM ecs_rpt_runs WHERE run_id=?", (run_id,))
    if r and r.get("as_of_date"):
        return r["as_of_date"]
    return date.today().isoformat()


def get_batch_range(conn: sqlite3.Connection) -> Tuple[int, int]:
    r = dict_row(conn, "SELECT MIN(batch_no) AS min_b, MAX(batch_no) AS max_b FROM ecs_rpt_customer_worklist")
    if not r or r["min_b"] is None or r["max_b"] is None:
        raise SystemExit("ecs_rpt_customer_worklist is empty or has null batch_no.")
    return int(r["min_b"]), int(r["max_b"])


def now_utc_z() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def xml_tag(tag: str, content) -> str:
    if content is None:
        content = ""
    return f"<{tag}>{xml_escape(str(content))}</{tag}>"


# -------------------------
# Worklist batch customers
# -------------------------
def fetch_batch_customer_ids(conn: sqlite3.Connection, batch_no: int) -> List[int]:
    rows = dict_rows(conn, """
        SELECT customer_id
        FROM ecs_rpt_customer_worklist
        WHERE batch_no=?
        ORDER BY customer_id
    """, (batch_no,))
    return [int(r["customer_id"]) for r in rows]


# -------------------------
# JSON payload -> XML converter (generic)
# -------------------------
def json_to_xml(value, node_name: str) -> str:
    """
    Generic converter:
    - dict -> <node><key>...</key>...</node>
    - list -> repeated <item>...</item> under <node>
    - scalar -> <node>value</node>
    """
    if isinstance(value, dict):
        inner = []
        for k, v in value.items():
            safe_k = "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in str(k))
            inner.append(json_to_xml(v, safe_k))
        return f"<{node_name}>" + "".join(inner) + f"</{node_name}>"

    if isinstance(value, list):
        inner = []
        for item in value:
            inner.append(json_to_xml(item, "item"))
        return f"<{node_name}>" + "".join(inner) + f"</{node_name}>"

    # scalar
    return xml_tag(node_name, value)


# -------------------------
# Build unified docs for one customer
# -------------------------
def build_unified(customer_id: int, as_of_date: str, module_payloads: Dict[str, Dict]) -> Tuple[str, str]:
    unified_json = {
        "schemaVersion": "1.0",
        "asOfDate": as_of_date,
        "customerId": customer_id,
        "modules": module_payloads
    }

    # XML: one root, module nodes contain payload converted to xml
    xml_parts = [
        f'<CustomerUnifiedReport schemaVersion="1.0" asOfDate="{xml_escape(as_of_date)}" customerId="{customer_id}">',
        "<Modules>"
    ]
    for module_code, payload in module_payloads.items():
        xml_parts.append(f"<{module_code}>")
        xml_parts.append(json_to_xml(payload, "payload"))
        xml_parts.append(f"</{module_code}>")
    xml_parts.append("</Modules></CustomerUnifiedReport>")

    return json.dumps(unified_json, ensure_ascii=False), "".join(xml_parts)


# -------------------------
# Fetch module docs for a batch, then unify
# -------------------------
def fetch_module_json_docs_for_batch(conn: sqlite3.Connection, run_id: int, customer_ids: List[int]) -> Dict[int, Dict[str, Dict]]:
    """
    Returns:
      { customer_id: { module_code: payload_dict } }
    Reads ecs_customer_rpt_modules.json_doc, extracts $.payload.
    """
    if not customer_ids:
        return {}

    # We can fetch in chunks to avoid big IN clause
    out: Dict[int, Dict[str, Dict]] = {cid: {} for cid in customer_ids}

    # Build a set for quick membership
    cid_set = set(customer_ids)

    # Pull all module rows for this run & these customers
    # (chunked IN to keep param count manageable)
    def chunks(lst, n=900):
        for i in range(0, len(lst), n):
            yield lst[i:i + n]

    for sub in chunks(customer_ids, 900):
        placeholders = ",".join(["?"] * len(sub))
        params = (run_id, *sub)

        rows = dict_rows(conn, f"""
            SELECT customer_id, module_code, json_doc
            FROM ecs_customer_rpt_modules
            WHERE run_id = ?
              AND customer_id IN ({placeholders})
              AND module_code IN ({",".join(["?"]*len(MODULES))})
        """, params + tuple(MODULES))

        for r in rows:
            cid = int(r["customer_id"])
            if cid not in cid_set:
                continue
            module_code = r["module_code"]
            try:
                doc = json.loads(r["json_doc"])
                payload = doc.get("payload", {})
            except Exception:
                payload = {"warning": "invalid json_doc"}
            out[cid][module_code] = payload

    # Ensure missing modules exist as empty payloads (consistent unified shape)
    for cid in customer_ids:
        for m in MODULES:
            out[cid].setdefault(m, {})

    return out


# -------------------------
# Insert unified rows into final table
# Assumes ecs_customer_rpt columns:
#   run_id, customer_id, json_doc, xml_doc, generated_at
# -------------------------
INSERT_UNIFIED_SQL = """
INSERT OR IGNORE INTO ecs_customer_rpt
  (run_id, customer_id, json_doc, xml_doc, generated_at)
VALUES (?, ?, ?, ?, ?)
"""


def insert_unified_rows(conn: sqlite3.Connection, rows: List[Tuple]):
    conn.executemany(INSERT_UNIFIED_SQL, rows)


def process_batch(conn: sqlite3.Connection, run_id: int, as_of_date: str, batch_no: int):
    customer_ids = fetch_batch_customer_ids(conn, batch_no)
    if not customer_ids:
        print(f"[batch {batch_no}] no customers, skipping.")
        return

    print(f"[batch {batch_no}] customers={len(customer_ids)} unifying...")
    generated_at = now_utc_z()

    # Load module payloads for this batch in bulk
    module_payloads_map = fetch_module_json_docs_for_batch(conn, run_id, customer_ids)

    rows_buf: List[Tuple] = []
    for i, cid in enumerate(customer_ids, start=1):
        payloads = module_payloads_map.get(cid, {m: {} for m in MODULES})
        final_json, final_xml = build_unified(cid, as_of_date, payloads)

        rows_buf.append((run_id, cid, final_json, final_xml, generated_at))

        if len(rows_buf) >= INSERT_CHUNK_SIZE:
            conn.execute("BEGIN;")
            insert_unified_rows(conn, rows_buf)
            conn.commit()
            rows_buf.clear()

        if i % PROGRESS_EVERY == 0:
            print(f"[batch {batch_no}] unified inserted {i}/{len(customer_ids)}")

    if rows_buf:
        conn.execute("BEGIN;")
        insert_unified_rows(conn, rows_buf)
        conn.commit()
        rows_buf.clear()

    cnt = dict_row(conn, """
        SELECT COUNT(*) AS cnt
        FROM ecs_customer_rpt r
        JOIN ecs_rpt_customer_worklist w ON w.customer_id = r.customer_id
        WHERE r.run_id=? AND w.batch_no=?
    """, (run_id, batch_no))["cnt"]
    print(f"[batch {batch_no}] DONE. unified rows in final table for this batch: {cnt}")


def main():
    conn = sqlite3.connect(DB_PATH, timeout=SQLITE_TIMEOUT_SECONDS)
    conn.row_factory = sqlite3.Row

    # performance pragmas
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA temp_store=MEMORY;")

    run_id = get_latest_run_id(conn)
    as_of_date = get_as_of_date(conn, run_id)
    b0, b1 = get_batch_range(conn)

    print("=====================================================")
    print("ETL: ecs_customer_rpt (Unified)")
    print(f"DB_PATH:     {DB_PATH}")
    print(f"RUN_ID:      {run_id}")
    print(f"AS_OF_DATE:  {as_of_date}")
    print(f"BATCH_RANGE: {b0}..{b1}")
    print(f"MODULES:     {MODULES}")
    print("=====================================================")

    for batch_no in range(b0, b1 + 1):
        process_batch(conn, run_id, as_of_date, batch_no)

    conn.close()
    print("All batches complete.")


if __name__ == "__main__":
    main()


