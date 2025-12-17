-- Customer Report
DROP TABLE IF EXISTS ecs_report_modules;
DROP TABLE IF EXISTS ecs_report_runs;
DROP TABLE IF EXISTS ecs_customer_report_modules;

CREATE TABLE IF NOT EXISTS ecs_rpt_modules (
  module_code   TEXT PRIMARY KEY,                 -- e.g. 'CUSTOMER_PROFILE'
  module_name   TEXT NOT NULL,
  description   TEXT,
  is_enabled    INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1)),
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ecs_rpt_runs (
  run_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date  DATE NOT NULL,
  started_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  status      TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCESS','FAILED')),
  note        TEXT
);

CREATE TABLE IF NOT EXISTS ecs_customer_rpt_modules (
  run_id      INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  module_code TEXT NOT NULL,
  json_doc    TEXT NOT NULL,
  xml_doc     TEXT NOT NULL,
  generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, customer_id, module_code),
  FOREIGN KEY (run_id) REFERENCES ecs_rpt_runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (module_code) REFERENCES ecs_rpt_modules(module_code)
);

CREATE INDEX IF NOT EXISTS idx_crm_customer ON ecs_customer_rpt_modules(customer_id);

CREATE TABLE IF NOT EXISTS ecs_customer_rpt (
  run_id      INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  json_doc    TEXT NOT NULL,
  xml_doc     TEXT NOT NULL,
  generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, customer_id),
  FOREIGN KEY (run_id) REFERENCES ecs_rpt_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cr_unified_customer ON ecs_customer_rpt(customer_id);


SELECT name FROM sqlite_master
WHERE type='table'
AND name LIKE 'ecs%rpt%';

INSERT OR IGNORE INTO ecs_rpt_modules(module_code, module_name, description) VALUES
('CUSTOMER_PROFILE','Customer Profile','Identity, contacts, addresses, KYC docs'),
('ACCOUNTS','Accounts','Accounts, products, holders, balances'),
('TRANSACTIONS','Transactions','Recent activity per account'),
('CARDS','Cards','Cards, auths, settlements'),
('LOANS','Loans','Loans, schedule summary, payments'),
('COMPLIANCE','Compliance','AML/KYC/Fraud flags'),
('FEES','Fees','Applied fees and totals');

SELECT * FROM ecs_rpt_modules ORDER BY module_code;

SELECT json_object('ok', 1);

-- Start a run
INSERT INTO ecs_rpt_runs(as_of_date, status, note)
VALUES (date('now'), 'RUNNING', 'Customer modular reports');

SELECT last_insert_rowid() AS run_id;

DELETE FROM ecs_customer_rpt_modules;

CREATE TABLE IF NOT EXISTS ecs_rpt_customer_worklist (
  customer_id INTEGER PRIMARY KEY,
  batch_no    INTEGER NOT NULL
);

DELETE FROM ecs_rpt_customer_worklist;

INSERT INTO ecs_rpt_customer_worklist(customer_id, batch_no)
SELECT
  customer_id,
  ((ROW_NUMBER() OVER (ORDER BY customer_id) - 1) / 5000) AS batch_no
FROM ecs_customers;