from pathlib import Path
import sqlite3

from auth_utils import hash_password

BASE = Path(__file__).resolve().parent.parent
DB_PATH = BASE / "database" / "MCH_DB.db"

CUSTOMER_USERNAME = "customer1"
CUSTOMER_PASSWORD = "Customer123!"
EMP_USERNAME = "employee1"
EMP_PASSWORD = "Employee123!"


def main():
    conn = sqlite3.connect(str(DB_PATH))
    try:
        cur = conn.cursor()

        # Pick a real customer_id from your reporting table (so the customer account is tied to real data)
        cur.execute("SELECT customer_id FROM ecs_customer_rpt LIMIT 1;")
        row = cur.fetchone()
        if not row:
            raise SystemExit("No rows in ecs_customer_rpt. Can't auto-pick a customer_id.")
        customer_id = row[0]

        # Upsert-ish behavior (delete if exists, then insert)
        cur.execute("DELETE FROM ecs_users WHERE username IN (?, ?);", (CUSTOMER_USERNAME, EMP_USERNAME))

        cur.execute(
            """
            INSERT INTO ecs_users (username, password_hash, role, customer_id, is_active)
            VALUES (?, ?, 'CUSTOMER', ?, 1)
            """,
            (CUSTOMER_USERNAME, hash_password(CUSTOMER_PASSWORD), str(customer_id)),
        )

        cur.execute(
            """
            INSERT INTO ecs_users (username, password_hash, role, customer_id, is_active)
            VALUES (?, ?, 'EMPLOYEE', NULL, 1)
            """,
            (EMP_USERNAME, hash_password(EMP_PASSWORD)),
        )

        conn.commit()

        print("Seeded users:")
        print(f"  CUSTOMER -> {CUSTOMER_USERNAME} / {CUSTOMER_PASSWORD}  (customer_id={customer_id})")
        print(f"  EMPLOYEE -> {EMP_USERNAME} / {EMP_PASSWORD}")

    finally:
        conn.close()


if __name__ == "__main__":
    main()
