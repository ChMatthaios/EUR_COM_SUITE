-- Users for login
CREATE TABLE IF NOT EXISTS ecs_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('CUSTOMER','EMPLOYEE','ADMIN')),
  customer_id TEXT,                 -- filled only for CUSTOMER users (maps to your customer id)
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ecs_users_role ON ecs_users(role);
CREATE INDEX IF NOT EXISTS idx_ecs_users_customer_id ON ecs_users(customer_id);