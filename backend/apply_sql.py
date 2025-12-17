from pathlib import Path
import sqlite3

BASE = Path(__file__).resolve().parent.parent
DB_PATH = BASE / "database" / "MCH_DB.db"
SQL_PATH = Path(__file__).resolve().parent / "sql" / "001_auth.sql"

print("DB:", DB_PATH)
print("SQL:", SQL_PATH)

sql = SQL_PATH.read_text(encoding="utf-8")

conn = sqlite3.connect(str(DB_PATH))
try:
    conn.executescript(sql)
    conn.commit()

    cur = conn.cursor()
    cur.execute("SELECT name, sql FROM sqlite_master WHERE type='table' AND name='ecs_users';")
    row = cur.fetchone()
    print("\nTable created:", bool(row))
    if row:
        print("\nSchema:\n", row[1])
finally:
    conn.close()
