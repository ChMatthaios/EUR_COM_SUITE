import sqlite3
import json
from datetime import datetime, date, timezone
from xml.sax.saxutils import escape as xml_escape
from typing import Dict, List, Tuple, Optional, DefaultDict
from collections import defaultdict

DB_PATH = r"###################################################################################"

# Modules to generate
MODULES_TO_RUN = [
    "CUSTOMER_PROFILE",
    "ACCOUNTS",
    "TRANSACTIONS",
    "CARDS",
    "LOANS",
    "COMPLIANCE",
    "FEES",
]

# Limits (tune if needed)
TXN_LIMIT_PER_CUSTOMER = 50
CARD_OPEN_AUTHS_LIMIT_PER_CUSTOMER = 50
CARD_SETTLEMENTS_LIMIT_PER_CUSTOMER = 20
LOAN_PAYMENTS_LIMIT_PER_CUSTOMER = 10
COMPLIANCE_FLAGS_LIMIT_PER_CUSTOMER = 50
FEES_LIMIT_PER_CUSTOMER = 50

# Performance / logging
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


INSERT_SQL = """
INSERT OR IGNORE INTO ecs_customer_rpt_modules
  (run_id, customer_id, module_code, json_doc, xml_doc, generated_at)
VALUES (?, ?, ?, ?, ?, ?)
"""


# -------------------------
# Batch fetching utilities
# -------------------------
def fetch_batch_customer_ids(conn: sqlite3.Connection, batch_no: int) -> List[int]:
    rows = dict_rows(conn, """
        SELECT customer_id
        FROM ecs_rpt_customer_worklist
        WHERE batch_no=?
        ORDER BY customer_id
    """, (batch_no,))
    return [int(r["customer_id"]) for r in rows]


def chunked(lst: List[int], size: int) -> List[List[int]]:
    return [lst[i:i + size] for i in range(0, len(lst), size)]


def in_clause_params(ids: List[int]) -> Tuple[str, Tuple]:
    placeholders = ",".join(["?"] * len(ids))
    return placeholders, tuple(ids)


def table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    r = dict_row(conn, "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", (table_name,))
    return bool(r)


# -------------------------
# CUSTOMER_PROFILE
# -------------------------
def build_customer_profile_docs_for_batch(conn, customer_ids: List[int], as_of_date: str) -> Dict[int, Tuple[str, str]]:
    if not customer_ids:
        return {}

    customers_map: Dict[int, Dict] = {}
    contacts_map: DefaultDict[int, List[Dict]] = defaultdict(list)
    addresses_map: DefaultDict[int, List[Dict]] = defaultdict(list)
    docs_map: DefaultDict[int, List[Dict]] = defaultdict(list)

    for ids in chunked(customer_ids, 900):
        ph, params = in_clause_params(ids)

        for row in dict_rows(conn, f"""
            SELECT customer_id, first_name, last_name, email, created_at
            FROM ecs_customers
            WHERE customer_id IN ({ph})
        """, params):
            customers_map[int(row["customer_id"])] = row

        for row in dict_rows(conn, f"""
            SELECT party_id, type, value, is_primary
            FROM ecs_party_contacts
            WHERE party_id IN ({ph})
            ORDER BY party_id, is_primary DESC, type, value
        """, params):
            contacts_map[int(row["party_id"])].append({
                "type": row["type"], "value": row["value"], "is_primary": row["is_primary"]
            })

        for row in dict_rows(conn, f"""
            SELECT pa.party_id, pa.addr_type, pa.is_primary,
                   a.line1, a.line2, a.city, a.region, a.postal_code, a.country
            FROM ecs_party_addresses pa
            JOIN ecs_addresses a ON a.address_id = pa.address_id
            WHERE pa.party_id IN ({ph})
            ORDER BY pa.party_id, pa.is_primary DESC, pa.addr_type
        """, params):
            addresses_map[int(row["party_id"])].append({
                "addr_type": row["addr_type"], "is_primary": row["is_primary"],
                "line1": row["line1"], "line2": row["line2"],
                "city": row["city"], "region": row["region"],
                "postal_code": row["postal_code"], "country": row["country"],
            })

        for row in dict_rows(conn, f"""
            SELECT party_id, doc_type, doc_number, issued_by, expires_on
            FROM ecs_party_id_documents
            WHERE party_id IN ({ph})
            ORDER BY party_id, doc_type, doc_number
        """, params):
            docs_map[int(row["party_id"])].append({
                "doc_type": row["doc_type"], "doc_number": row["doc_number"],
                "issued_by": row["issued_by"], "expires_on": row["expires_on"],
            })

    out: Dict[int, Tuple[str, str]] = {}

    for cid in customer_ids:
        c = customers_map.get(cid)

        payload = {
            "customer": {
                "customerId": cid,
                "existsInEcsCustomers": bool(c),
                "firstName": c["first_name"] if c else None,
                "lastName": c["last_name"] if c else None,
                "email": c["email"] if c else None,
                "createdAt": c["created_at"] if c else None,
            },
            "contacts": contacts_map.get(cid, []),
            "addresses": addresses_map.get(cid, []),
            "kycDocuments": docs_map.get(cid, []),
        }

        json_doc = {
            "schemaVersion": "1.0",
            "module": "CUSTOMER_PROFILE",
            "asOfDate": as_of_date,
            "customerId": cid,
            "payload": payload
        }

        xml_parts = [
            f'<CustomerProfileReport schemaVersion="1.0" asOfDate="{xml_escape(as_of_date)}" customerId="{cid}">',
            "<Customer>",
            xml_tag("CustomerId", cid),
        ]
        if c:
            xml_parts += [
                xml_tag("FirstName", c["first_name"]),
                xml_tag("LastName", c["last_name"]),
                xml_tag("Email", c["email"]),
                xml_tag("CreatedAt", c["created_at"]),
            ]
        else:
            xml_parts.append("<MissingCustomer>true</MissingCustomer>")
        xml_parts.append("</Customer>")

        xml_parts.append("<Contacts>")
        for ct in contacts_map.get(cid, []):
            xml_parts.append(
                f'<Contact type="{xml_escape(ct["type"])}" isPrimary="{ct["is_primary"]}">'
                f'{xml_tag("Value", ct["value"])}'
                f"</Contact>"
            )
        xml_parts.append("</Contacts>")

        xml_parts.append("<Addresses>")
        for ad in addresses_map.get(cid, []):
            xml_parts.append(
                f'<Address addrType="{xml_escape(ad["addr_type"])}" isPrimary="{ad["is_primary"]}">'
                f'{xml_tag("Line1", ad["line1"])}'
                f'{xml_tag("Line2", ad["line2"])}'
                f'{xml_tag("City", ad["city"])}'
                f'{xml_tag("Region", ad["region"])}'
                f'{xml_tag("PostalCode", ad["postal_code"])}'
                f'{xml_tag("Country", ad["country"])}'
                f"</Address>"
            )
        xml_parts.append("</Addresses>")

        xml_parts.append("<KycDocuments>")
        for d in docs_map.get(cid, []):
            xml_parts.append(
                f'<Document docType="{xml_escape(d["doc_type"])}">'
                f'{xml_tag("DocNumber", d["doc_number"])}'
                f'{xml_tag("IssuedBy", d["issued_by"])}'
                f'{xml_tag("ExpiresOn", d["expires_on"])}'
                f"</Document>"
            )
        xml_parts.append("</KycDocuments>")

        xml_parts.append("</CustomerProfileReport>")
        out[cid] = (json.dumps(json_doc, ensure_ascii=False), "".join(xml_parts))

    return out


# -------------------------
# ACCOUNTS
# -------------------------
def build_accounts_docs_for_batch(conn, customer_ids: List[int], as_of_date: str) -> Dict[int, Tuple[str, str]]:
    if not customer_ids:
        return {}

    cust_to_accounts: DefaultDict[int, List[int]] = defaultdict(list)
    account_ids_set = set()

    for ids in chunked(customer_ids, 900):
        ph, params = in_clause_params(ids)
        for row in dict_rows(conn, f"""
            SELECT party_id, account_id
            FROM ecs_account_holders
            WHERE party_id IN ({ph})
            ORDER BY party_id, account_id
        """, params):
            pid = int(row["party_id"])
            aid = int(row["account_id"])
            cust_to_accounts[pid].append(aid)
            account_ids_set.add(aid)

    account_ids = sorted(account_ids_set)

    acc_map: Dict[int, Dict] = {}
    holders_map: DefaultDict[int, List[Dict]] = defaultdict(list)
    bal_map: Dict[int, float] = defaultdict(float)

    if account_ids:
        for aids in chunked(account_ids, 900):
            ph, params = in_clause_params(aids)
            for row in dict_rows(conn, f"""
                SELECT a.account_id, a.account_number, a.status,
                       dp.code AS product_code, dp.name AS product_name, dp.currency_code,
                       dp.overdraft_allowed, dp.overdraft_limit
                FROM ecs_accounts a
                JOIN ecs_deposit_products dp ON dp.product_id = a.product_id
                WHERE a.account_id IN ({ph})
            """, params):
                acc_map[int(row["account_id"])] = {
                    "account_id": row["account_id"],
                    "account_number": row["account_number"],
                    "status": row["status"],
                    "product_code": row["product_code"],
                    "product_name": row["product_name"],
                    "currency_code": row["currency_code"],
                    "overdraft_allowed": row["overdraft_allowed"],
                    "overdraft_limit": row["overdraft_limit"],
                    "holders": [],
                    "balance": 0.0,
                }

        for aids in chunked(account_ids, 900):
            ph, params = in_clause_params(aids)
            for row in dict_rows(conn, f"""
                SELECT h.account_id, h.party_id, h.role, p.full_name
                FROM ecs_account_holders h
                JOIN ecs_parties p ON p.party_id = h.party_id
                WHERE h.account_id IN ({ph})
                ORDER BY h.account_id,
                         CASE h.role WHEN 'PRIMARY' THEN 0 WHEN 'JOINT' THEN 1 ELSE 2 END,
                         h.party_id
            """, params):
                holders_map[int(row["account_id"])].append({
                    "party_id": row["party_id"],
                    "role": row["role"],
                    "full_name": row["full_name"],
                })

        for aids in chunked(account_ids, 900):
            ph, params = in_clause_params(aids)
            for row in dict_rows(conn, f"""
                SELECT ap.account_id, ROUND(COALESCE(SUM(ap.amount),0), 2) AS balance
                FROM ecs_account_postings ap
                JOIN ecs_journal_entries je ON je.entry_id = ap.entry_id
                WHERE je.status='POSTED'
                  AND ap.account_id IN ({ph})
                GROUP BY ap.account_id
            """, params):
                bal_map[int(row["account_id"])] = float(row["balance"])

        for aid, acc in acc_map.items():
            acc["holders"] = holders_map.get(aid, [])
            acc["balance"] = bal_map.get(aid, 0.0)

    out: Dict[int, Tuple[str, str]] = {}
    for cid in customer_ids:
        aids = cust_to_accounts.get(cid, [])
        accounts = [acc_map[aid] for aid in aids if aid in acc_map]

        payload = {"accounts": accounts}
        json_doc = {
            "schemaVersion": "1.0",
            "module": "ACCOUNTS",
            "asOfDate": as_of_date,
            "customerId": cid,
            "payload": payload
        }

        xml_parts = [
            f'<AccountsReport schemaVersion="1.0" asOfDate="{xml_escape(as_of_date)}" customerId="{cid}">',
            "<Accounts>"
        ]
        for a in accounts:
            xml_parts.append("<Account>")
            xml_parts.append(xml_tag("AccountId", a["account_id"]))
            xml_parts.append(xml_tag("AccountNumber", a["account_number"]))
            xml_parts.append(xml_tag("Status", a["status"]))
            xml_parts.append(xml_tag("Currency", a["currency_code"]))
            xml_parts.append(f'<Product code="{xml_escape(a["product_code"])}">{xml_escape(a["product_name"])}</Product>')
            xml_parts.append(xml_tag("Balance", a["balance"]))
            xml_parts.append(f'<Overdraft allowed="{a["overdraft_allowed"]}">{xml_tag("Limit", a["overdraft_limit"])}</Overdraft>')
            xml_parts.append("<Holders>")
            for h in a["holders"]:
                xml_parts.append(
                    f'<Holder role="{xml_escape(h["role"])}">'
                    f'{xml_tag("PartyId", h["party_id"])}'
                    f'{xml_tag("FullName", h["full_name"])}'
                    f"</Holder>"
                )
            xml_parts.append("</Holders>")
            xml_parts.append("</Account>")
        xml_parts.append("</Accounts></AccountsReport>")

        out[cid] = (json.dumps(json_doc, ensure_ascii=False), "".join(xml_parts))

    return out


# -------------------------
# TRANSACTIONS
# Uses ecs_transactions if present & has rows; otherwise uses postings+journal_entries.
# Output: last N transactions per customer across all their accounts.
# -------------------------
def build_transactions_docs_for_batch(conn, customer_ids: List[int], as_of_date: str) -> Dict[int, Tuple[str, str]]:
    if not customer_ids:
        return {}

    has_ecs_transactions = table_exists(conn, "ecs_transactions")
    txn_count = dict_row(conn, "SELECT COUNT(*) AS cnt FROM ecs_transactions")["cnt"] if has_ecs_transactions else 0

    # customer -> account_ids
    cust_to_accounts: DefaultDict[int, List[int]] = defaultdict(list)
    account_to_customer: Dict[int, List[int]] = defaultdict(list)
    all_account_ids = set()

    for ids in chunked(customer_ids, 900):
        ph, params = in_clause_params(ids)
        for row in dict_rows(conn, f"""
            SELECT party_id, account_id
            FROM ecs_account_holders
            WHERE party_id IN ({ph})
        """, params):
            pid = int(row["party_id"])
            aid = int(row["account_id"])
            cust_to_accounts[pid].append(aid)
            account_to_customer[aid].append(pid)
            all_account_ids.add(aid)

    account_ids = sorted(all_account_ids)

    # Build per-customer list of txns (we will collect and later trim per customer)
    cust_txns: DefaultDict[int, List[Dict]] = defaultdict(list)

    if account_ids:
        for aids in chunked(account_ids, 900):
            ph, params = in_clause_params(aids)

            if has_ecs_transactions and txn_count > 0:
                # txn_type, amount, txn_ts, description, transfer_id etc.
                rows = dict_rows(conn, f"""
                    SELECT account_id, txn_type, amount, txn_ts, description, transfer_id, transaction_id
                    FROM ecs_transactions
                    WHERE account_id IN ({ph})
                    ORDER BY txn_ts DESC
                """, params)
                for r in rows:
                    aid = int(r["account_id"])
                    for cid in account_to_customer.get(aid, []):
                        cust_txns[cid].append({
                            "source": "ecs_transactions",
                            "transactionId": r.get("transaction_id"),
                            "accountId": aid,
                            "type": r.get("txn_type"),
                            "amount": r.get("amount"),
                            "timestamp": r.get("txn_ts"),
                            "description": r.get("description"),
                            "transferId": r.get("transfer_id"),
                        })
            else:
                # fallback: postings + journal entry metadata
                rows = dict_rows(conn, f"""
                    SELECT ap.account_id, ap.amount, ap.posting_ts, ap.description,
                           je.entry_id, je.source AS entry_source, je.reference, je.entry_ts
                    FROM ecs_account_postings ap
                    JOIN ecs_journal_entries je ON je.entry_id = ap.entry_id
                    WHERE je.status='POSTED'
                      AND ap.account_id IN ({ph})
                    ORDER BY ap.posting_ts DESC
                """, params)
                for r in rows:
                    aid = int(r["account_id"])
                    for cid in account_to_customer.get(aid, []):
                        cust_txns[cid].append({
                            "source": "ecs_account_postings",
                            "entryId": r.get("entry_id"),
                            "accountId": aid,
                            "amount": r.get("amount"),
                            "postingTs": r.get("posting_ts"),
                            "description": r.get("description"),
                            "entrySource": r.get("entry_source"),
                            "reference": r.get("reference"),
                            "entryTs": r.get("entry_ts"),
                        })

    out: Dict[int, Tuple[str, str]] = {}
    for cid in customer_ids:
        txns = cust_txns.get(cid, [])

        # sort newest first using whichever timestamp we have
        def ts_key(x):
            return x.get("timestamp") or x.get("postingTs") or ""

        txns_sorted = sorted(txns, key=ts_key, reverse=True)[:TXN_LIMIT_PER_CUSTOMER]

        payload = {"transactions": txns_sorted, "limit": TXN_LIMIT_PER_CUSTOMER}
        json_doc = {
            "schemaVersion": "1.0",
            "module": "TRANSACTIONS",
            "asOfDate": as_of_date,
            "customerId": cid,
            "payload": payload
        }

        xml_parts = [
            f'<TransactionsReport schemaVersion="1.0" asOfDate="{xml_escape(as_of_date)}" customerId="{cid}">',
            f'<Transactions limit="{TXN_LIMIT_PER_CUSTOMER}">'
        ]
        for t in txns_sorted:
            xml_parts.append("<Transaction>")
            for k, v in t.items():
                xml_parts.append(xml_tag(k, v))
            xml_parts.append("</Transaction>")
        xml_parts.append("</Transactions></TransactionsReport>")

        out[cid] = (json.dumps(json_doc, ensure_ascii=False), "".join(xml_parts))

    return out


# -------------------------
# CARDS
# cards + open authorizations + recent settlements
# -------------------------
def build_cards_docs_for_batch(conn, customer_ids: List[int], as_of_date: str) -> Dict[int, Tuple[str, str]]:
    if not customer_ids:
        return {}

    # customer -> account_ids
    cust_to_accounts: DefaultDict[int, List[int]] = defaultdict(list)
    all_account_ids = set()
    for ids in chunked(customer_ids, 900):
        ph, params = in_clause_params(ids)
        for row in dict_rows(conn, f"""
            SELECT party_id, account_id
            FROM ecs_account_holders
            WHERE party_id IN ({ph})
        """, params):
            pid = int(row["party_id"])
            aid = int(row["account_id"])
            cust_to_accounts[pid].append(aid)
            all_account_ids.add(aid)

    account_ids = sorted(all_account_ids)
    # Prefetch cards for those accounts
    cards_by_customer: DefaultDict[int, List[Dict]] = defaultdict(list)
    cards_map: Dict[int, Dict] = {}

    if account_ids:
        for aids in chunked(account_ids, 900):
            ph, params = in_clause_params(aids)
            for row in dict_rows(conn, f"""
                SELECT card_id, account_id, pan_last4, card_type, status, issued_at, expires_on
                FROM ecs_cards
                WHERE account_id IN ({ph})
            """, params):
                cid_list = [c for c in customer_ids if int(row["account_id"]) in cust_to_accounts.get(c, [])]
                card = {
                    "cardId": row["card_id"],
                    "accountId": row["account_id"],
                    "panLast4": row["pan_last4"],
                    "cardType": row["card_type"],
                    "status": row["status"],
                    "issuedAt": row["issued_at"],
                    "expiresOn": row["expires_on"],
                    "openAuthorizations": [],
                    "recentSettlements": [],
                }
                cards_map[int(row["card_id"])] = card
                # attach to each relevant customer (usually 1)
                for cust in cid_list:
                    cards_by_customer[cust].append(card)

        # Prefetch open auths for all cards involved
        all_card_ids = sorted(cards_map.keys())
        if all_card_ids:
            for cids in chunked(all_card_ids, 900):
                ph, params = in_clause_params(cids)
                auths = dict_rows(conn, f"""
                    SELECT auth_id, card_id, account_id, amount, merchant, auth_ts, status, reference
                    FROM ecs_card_authorizations
                    WHERE card_id IN ({ph})
                      AND status='APPROVED'
                    ORDER BY auth_ts DESC
                """, params)
                auths_by_card: DefaultDict[int, List[Dict]] = defaultdict(list)
                for a in auths:
                    auths_by_card[int(a["card_id"])].append({
                        "authId": a["auth_id"],
                        "accountId": a["account_id"],
                        "amount": a["amount"],
                        "merchant": a["merchant"],
                        "authTs": a["auth_ts"],
                        "status": a["status"],
                        "reference": a["reference"],
                    })
                for card_id, lst in auths_by_card.items():
                    cards_map[card_id]["openAuthorizations"] = lst[:CARD_OPEN_AUTHS_LIMIT_PER_CUSTOMER]

            # Prefetch settlements (join to auths)
            settlements = dict_rows(conn, """
                SELECT s.settlement_id, s.auth_id, s.entry_id, s.settled_ts,
                       a.card_id, a.amount, a.merchant, a.reference
                FROM ecs_card_settlements s
                JOIN ecs_card_authorizations a ON a.auth_id = s.auth_id
                WHERE a.card_id IN ({})
                ORDER BY s.settled_ts DESC
            """.format(",".join(["?"] * len(all_card_ids))), tuple(all_card_ids))

            settle_by_card: DefaultDict[int, List[Dict]] = defaultdict(list)
            for s in settlements:
                settle_by_card[int(s["card_id"])].append({
                    "settlementId": s["settlement_id"],
                    "authId": s["auth_id"],
                    "entryId": s["entry_id"],
                    "settledTs": s["settled_ts"],
                    "amount": s["amount"],
                    "merchant": s["merchant"],
                    "reference": s["reference"],
                })
            for card_id, lst in settle_by_card.items():
                cards_map[card_id]["recentSettlements"] = lst[:CARD_SETTLEMENTS_LIMIT_PER_CUSTOMER]

    out: Dict[int, Tuple[str, str]] = {}
    for cust_id in customer_ids:
        payload = {"cards": cards_by_customer.get(cust_id, [])}
        json_doc = {
            "schemaVersion": "1.0",
            "module": "CARDS",
            "asOfDate": as_of_date,
            "customerId": cust_id,
            "payload": payload
        }
        xml_parts = [
            f'<CardsReport schemaVersion="1.0" asOfDate="{xml_escape(as_of_date)}" customerId="{cust_id}"><Cards>'
        ]
        for card in cards_by_customer.get(cust_id, []):
            xml_parts.append('<Card>')
            xml_parts.append(xml_tag("CardId", card["cardId"]))
            xml_parts.append(xml_tag("AccountId", card["accountId"]))
            xml_parts.append(xml_tag("PanLast4", card["panLast4"]))
            xml_parts.append(xml_tag("CardType", card["cardType"]))
            xml_parts.append(xml_tag("Status", card["status"]))
            xml_parts.append(xml_tag("IssuedAt", card["issuedAt"]))
            xml_parts.append(xml_tag("ExpiresOn", card["expiresOn"]))

            xml_parts.append('<OpenAuthorizations>')
            for a in card["openAuthorizations"]:
                xml_parts.append('<Authorization>')
                for k, v in a.items():
                    xml_parts.append(xml_tag(k, v))
                xml_parts.append('</Authorization>')
            xml_parts.append('</OpenAuthorizations>')

            xml_parts.append('<RecentSettlements>')
            for s in card["recentSettlements"]:
                xml_parts.append('<Settlement>')
                for k, v in s.items():
                    xml_parts.append(xml_tag(k, v))
                xml_parts.append('</Settlement>')
            xml_parts.append('</RecentSettlements>')

            xml_parts.append('</Card>')
        xml_parts.append('</Cards></CardsReport>')
        out[cust_id] = (json.dumps(json_doc, ensure_ascii=False), "".join(xml_parts))
    return out


# -------------------------
# LOANS
# -------------------------
def build_loans_docs_for_batch(conn, customer_ids: List[int], as_of_date: str) -> Dict[int, Tuple[str, str]]:
    if not customer_ids:
        return {}

    loans_by_customer: DefaultDict[int, List[Dict]] = defaultdict(list)
    loan_ids = []

    for ids in chunked(customer_ids, 900):
        ph, params = in_clause_params(ids)
        for row in dict_rows(conn, f"""
            SELECT loan_id, party_id, branch_id, loan_product_id, principal, apr, term_months, status, originated_at
            FROM ecs_loans
            WHERE party_id IN ({ph})
            ORDER BY originated_at DESC
        """, params):
            loan = {
                "loanId": row["loan_id"],
                "partyId": row["party_id"],
                "branchId": row["branch_id"],
                "loanProductId": row["loan_product_id"],
                "principal": row["principal"],
                "apr": row["apr"],
                "termMonths": row["term_months"],
                "status": row["status"],
                "originatedAt": row["originated_at"],
                "nextDue": None,
                "recentPayments": [],
            }
            loans_by_customer[int(row["party_id"])].append(loan)
            loan_ids.append(int(row["loan_id"]))

    loan_ids = sorted(set(loan_ids))
    if loan_ids:
        # next due per loan (first DUE installment)
        for lids in chunked(loan_ids, 900):
            ph, params = in_clause_params(lids)
            due_rows = dict_rows(conn, f"""
                SELECT loan_id, installment_no, due_date, due_principal, due_interest
                FROM ecs_loan_schedule
                WHERE loan_id IN ({ph}) AND status='DUE'
                ORDER BY loan_id, due_date
            """, params)
            next_due_map = {}
            for r in due_rows:
                lid = int(r["loan_id"])
                if lid not in next_due_map:
                    next_due_map[lid] = {
                        "installmentNo": r["installment_no"],
                        "dueDate": r["due_date"],
                        "duePrincipal": r["due_principal"],
                        "dueInterest": r["due_interest"],
                    }

            # recent payments
            pay_rows = dict_rows(conn, f"""
                SELECT payment_id, loan_id, entry_id, paid_at, amount
                FROM ecs_loan_payments
                WHERE loan_id IN ({ph})
                ORDER BY paid_at DESC
            """, params)
            pay_map: DefaultDict[int, List[Dict]] = defaultdict(list)
            for p in pay_rows:
                pay_map[int(p["loan_id"])].append({
                    "paymentId": p["payment_id"],
                    "entryId": p["entry_id"],
                    "paidAt": p["paid_at"],
                    "amount": p["amount"],
                })

            # attach into loans structure
            for cust_id, lst in loans_by_customer.items():
                for loan in lst:
                    lid = int(loan["loanId"])
                    if lid in next_due_map:
                        loan["nextDue"] = next_due_map[lid]
                    if lid in pay_map:
                        loan["recentPayments"] = pay_map[lid][:LOAN_PAYMENTS_LIMIT_PER_CUSTOMER]

    out: Dict[int, Tuple[str, str]] = {}
    for cust_id in customer_ids:
        payload = {"loans": loans_by_customer.get(cust_id, [])}
        json_doc = {
            "schemaVersion": "1.0",
            "module": "LOANS",
            "asOfDate": as_of_date,
            "customerId": cust_id,
            "payload": payload
        }
        xml_parts = [f'<LoansReport schemaVersion="1.0" asOfDate="{xml_escape(as_of_date)}" customerId="{cust_id}"><Loans>']
        for loan in loans_by_customer.get(cust_id, []):
            xml_parts.append("<Loan>")
            for k in ["loanId", "principal", "apr", "termMonths", "status", "originatedAt"]:
                xml_parts.append(xml_tag(k, loan.get(k)))
            if loan.get("nextDue"):
                xml_parts.append("<NextDue>")
                for k, v in loan["nextDue"].items():
                    xml_parts.append(xml_tag(k, v))
                xml_parts.append("</NextDue>")
            xml_parts.append("<RecentPayments>")
            for p in loan.get("recentPayments", []):
                xml_parts.append("<Payment>")
                for k, v in p.items():
                    xml_parts.append(xml_tag(k, v))
                xml_parts.append("</Payment>")
            xml_parts.append("</RecentPayments>")
            xml_parts.append("</Loan>")
        xml_parts.append("</Loans></LoansReport>")
        out[cust_id] = (json.dumps(json_doc, ensure_ascii=False), "".join(xml_parts))
    return out


# -------------------------
# COMPLIANCE
# -------------------------
def build_compliance_docs_for_batch(conn, customer_ids: List[int], as_of_date: str) -> Dict[int, Tuple[str, str]]:
    if not customer_ids:
        return {}

    flags_by_customer: DefaultDict[int, List[Dict]] = defaultdict(list)

    for ids in chunked(customer_ids, 900):
        ph, params = in_clause_params(ids)
        rows = dict_rows(conn, f"""
            SELECT flag_id, party_id, account_id, severity, category, note, created_at, status
            FROM ecs_compliance_flags
            WHERE party_id IN ({ph})
            ORDER BY party_id,
                     CASE status WHEN 'OPEN' THEN 0 ELSE 1 END,
                     created_at DESC
        """, params)
        for r in rows:
            flags_by_customer[int(r["party_id"])].append({
                "flagId": r["flag_id"],
                "accountId": r["account_id"],
                "severity": r["severity"],
                "category": r["category"],
                "note": r["note"],
                "createdAt": r["created_at"],
                "status": r["status"],
            })

    out: Dict[int, Tuple[str, str]] = {}
    for cid in customer_ids:
        flags = flags_by_customer.get(cid, [])[:COMPLIANCE_FLAGS_LIMIT_PER_CUSTOMER]
        payload = {"flags": flags, "limit": COMPLIANCE_FLAGS_LIMIT_PER_CUSTOMER}
        json_doc = {
            "schemaVersion": "1.0",
            "module": "COMPLIANCE",
            "asOfDate": as_of_date,
            "customerId": cid,
            "payload": payload
        }
        xml_parts = [
            f'<ComplianceReport schemaVersion="1.0" asOfDate="{xml_escape(as_of_date)}" customerId="{cid}"><Flags>'
        ]
        for f in flags:
            xml_parts.append("<Flag>")
            for k, v in f.items():
                xml_parts.append(xml_tag(k, v))
            xml_parts.append("</Flag>")
        xml_parts.append("</Flags></ComplianceReport>")
        out[cid] = (json.dumps(json_doc, ensure_ascii=False), "".join(xml_parts))
    return out


# -------------------------
# FEES
# -------------------------
def build_fees_docs_for_batch(conn, customer_ids: List[int], as_of_date: str) -> Dict[int, Tuple[str, str]]:
    if not customer_ids:
        return {}

    # customer -> account_ids
    cust_to_accounts: DefaultDict[int, List[int]] = defaultdict(list)
    all_account_ids = set()
    for ids in chunked(customer_ids, 900):
        ph, params = in_clause_params(ids)
        for row in dict_rows(conn, f"""
            SELECT party_id, account_id
            FROM ecs_account_holders
            WHERE party_id IN ({ph})
        """, params):
            pid = int(row["party_id"])
            aid = int(row["account_id"])
            cust_to_accounts[pid].append(aid)
            all_account_ids.add(aid)

    account_ids = sorted(all_account_ids)
    fees_by_customer: DefaultDict[int, List[Dict]] = defaultdict(list)

    if account_ids:
        for aids in chunked(account_ids, 900):
            ph, params = in_clause_params(aids)
            rows = dict_rows(conn, f"""
                SELECT fa.fee_id, fa.account_id, fa.entry_id, fa.applied_at,
                       ft.code AS fee_code, ft.name AS fee_name, ft.amount AS fee_amount
                FROM ecs_fees_applied fa
                JOIN ecs_fee_types ft ON ft.fee_type_id = fa.fee_type_id
                WHERE fa.account_id IN ({ph})
                ORDER BY fa.applied_at DESC
            """, params)

            account_to_customers: DefaultDict[int, List[int]] = defaultdict(list)
            for cust_id, a_list in cust_to_accounts.items():
                for a in a_list:
                    account_to_customers[a].append(cust_id)

            for r in rows:
                aid = int(r["account_id"])
                fee_obj = {
                    "feeId": r["fee_id"],
                    "accountId": aid,
                    "entryId": r["entry_id"],
                    "appliedAt": r["applied_at"],
                    "feeCode": r["fee_code"],
                    "feeName": r["fee_name"],
                    "feeAmount": r["fee_amount"],
                }
                for cust_id in account_to_customers.get(aid, []):
                    fees_by_customer[cust_id].append(fee_obj)

    out: Dict[int, Tuple[str, str]] = {}
    for cid in customer_ids:
        fees = fees_by_customer.get(cid, [])
        fees_sorted = sorted(fees, key=lambda x: x.get("appliedAt") or "", reverse=True)[:FEES_LIMIT_PER_CUSTOMER]
        payload = {"fees": fees_sorted, "limit": FEES_LIMIT_PER_CUSTOMER}
        json_doc = {
            "schemaVersion": "1.0",
            "module": "FEES",
            "asOfDate": as_of_date,
            "customerId": cid,
            "payload": payload
        }
        xml_parts = [f'<FeesReport schemaVersion="1.0" asOfDate="{xml_escape(as_of_date)}" customerId="{cid}"><Fees>']
        for f in fees_sorted:
            xml_parts.append("<Fee>")
            for k, v in f.items():
                xml_parts.append(xml_tag(k, v))
            xml_parts.append("</Fee>")
        xml_parts.append("</Fees></FeesReport>")
        out[cid] = (json.dumps(json_doc, ensure_ascii=False), "".join(xml_parts))
    return out


# -------------------------
# Module dispatcher
# -------------------------
def build_module_docs_for_batch(conn, module: str, customer_ids: List[int], as_of_date: str) -> Dict[int, Tuple[str, str]]:
    if module == "CUSTOMER_PROFILE":
        return build_customer_profile_docs_for_batch(conn, customer_ids, as_of_date)
    if module == "ACCOUNTS":
        return build_accounts_docs_for_batch(conn, customer_ids, as_of_date)
    if module == "TRANSACTIONS":
        return build_transactions_docs_for_batch(conn, customer_ids, as_of_date)
    if module == "CARDS":
        return build_cards_docs_for_batch(conn, customer_ids, as_of_date)
    if module == "LOANS":
        return build_loans_docs_for_batch(conn, customer_ids, as_of_date)
    if module == "COMPLIANCE":
        return build_compliance_docs_for_batch(conn, customer_ids, as_of_date)
    if module == "FEES":
        return build_fees_docs_for_batch(conn, customer_ids, as_of_date)
    raise ValueError(f"Unsupported module: {module}")


# -------------------------
# ETL
# -------------------------
def insert_rows(conn: sqlite3.Connection, rows: List[Tuple]):
    conn.executemany(INSERT_SQL, rows)


def process_batch(conn: sqlite3.Connection, run_id: int, batch_no: int, as_of_date: str):
    customer_ids = fetch_batch_customer_ids(conn, batch_no)
    if not customer_ids:
        print(f"[batch {batch_no}] no customers, skipping.")
        return

    print(f"[batch {batch_no}] customers={len(customer_ids)} starting...")
    generated_at = now_utc_z()

    for module in MODULES_TO_RUN:
        print(f"[batch {batch_no}] module={module} prefetching...")
        docs = build_module_docs_for_batch(conn, module, customer_ids, as_of_date)

        # insert in chunks
        rows_buf: List[Tuple] = []
        for i, cid in enumerate(customer_ids, start=1):
            json_doc, xml_doc = docs.get(cid, (None, None))
            if json_doc is None:
                # Should not happen often; but keep it safe
                json_doc = json.dumps({
                    "schemaVersion": "1.0",
                    "module": module,
                    "asOfDate": as_of_date,
                    "customerId": cid,
                    "payload": {"warning": "no data generated"}
                }, ensure_ascii=False)
                xml_doc = f'<{module}Report schemaVersion="1.0" asOfDate="{xml_escape(as_of_date)}" customerId="{cid}"><Warning>no data generated</Warning></{module}Report>'

            rows_buf.append((run_id, cid, module, json_doc, xml_doc, generated_at))

            if len(rows_buf) >= INSERT_CHUNK_SIZE:
                conn.execute("BEGIN;")
                insert_rows(conn, rows_buf)
                conn.commit()
                rows_buf.clear()

            if i % PROGRESS_EVERY == 0:
                print(f"[batch {batch_no}] module={module} inserted {i}/{len(customer_ids)}")

        if rows_buf:
            conn.execute("BEGIN;")
            insert_rows(conn, rows_buf)
            conn.commit()
            rows_buf.clear()

        cnt = dict_row(conn, """
            SELECT COUNT(*) AS cnt
            FROM ecs_customer_rpt_modules m
            JOIN ecs_rpt_customer_worklist w ON w.customer_id = m.customer_id
            WHERE m.run_id=? AND m.module_code=? AND w.batch_no=?
        """, (run_id, module, batch_no))["cnt"]
        print(f"[batch {batch_no}] module={module} DONE. rows in table for this batch: {cnt}")

    print(f"[batch {batch_no}] finished.")


def main():
    conn = sqlite3.connect(DB_PATH, timeout=SQLITE_TIMEOUT_SECONDS)
    conn.row_factory = sqlite3.Row

    # Performance PRAGMAs
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA temp_store=MEMORY;")

    run_id = get_latest_run_id(conn)
    as_of_date = get_as_of_date(conn, run_id)
    b0, b1 = get_batch_range(conn)

    print("=====================================================")
    print("ETL: ecs_customer_rpt_modules (Python, FAST batch prefetch)")
    print(f"DB_PATH:     {DB_PATH}")
    print(f"RUN_ID:      {run_id}")
    print(f"AS_OF_DATE:  {as_of_date}")
    print(f"BATCH_RANGE: {b0}..{b1}")
    print(f"MODULES:     {MODULES_TO_RUN}")
    print("=====================================================")

    for batch_no in range(b0, b1 + 1):
        process_batch(conn, run_id, batch_no, as_of_date)

    conn.close()
    print("All batches complete.")


if __name__ == "__main__":
    main()

