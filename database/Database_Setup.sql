SELECT sqlite_version() AS sqlite_version;

CREATE TABLE ecs_customers (
    customer_id INTEGER PRIMARY KEY AUTOINCREMENT, 
    first_name  TEXT NOT NULL, 
    last_name   TEXT NOT NULL, 
    email       TEXT UNIQUE NOT NULL, 
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

PRAGMA table_info(ecs_customers);

CREATE TABLE ecs_accounts (
    account_id   INTEGER PRIMARY KEY AUTOINCREMENT, 
    customer_id  INTEGER NOT NULL, 
    account_type TEXT NOT NULL CHECK (account_type IN ('CHECKING', 'SAVINGS')), 
    balance      REAL NOT NULL DEFAULT 0.0, 
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP, 
    FOREIGN KEY (customer_id)
        REFERENCES ecs_customers(customer_id) ON DELETE CASCADE
);

PRAGMA foreign_key_list(ecs_accounts);

PRAGMA foreign_keys = ON;
PRAGMA foreign_keys;

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;

PRAGMA journal_mode;

WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
     nums(n) AS ( SELECT a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 10000 * e.d AS n
                    FROM digits a
                   CROSS JOIN digits b
                   CROSS JOIN digits c
                   CROSS JOIN digits d
                   CROSS JOIN digits e )
INSERT INTO ecs_customers (first_name, last_name, email)
SELECT 'First' || n, 'Last' || n, 'user' || n || '@bank.local'
  FROM nums
 WHERE n < 100000;

SELECT COUNT(*) AS customers_count
FROM ecs_customers;

WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
     nums(n) AS ( SELECT a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 10000 * e.d AS n
                    FROM digits a
                   CROSS JOIN digits b
                   CROSS JOIN digits c
                   CROSS JOIN digits d
                   CROSS JOIN digits e )
INSERT INTO ecs_accounts (customer_id, account_type, balance)
SELECT (n % 100000) + 1 AS customer_id,
       CASE WHEN (n % 2) = 0 THEN 'CHECKING' ELSE 'SAVINGS' END AS account_type,
       0.0 AS balance
  FROM nums
 WHERE n < 150000;

SELECT COUNT(*) AS accounts_count FROM ecs_accounts;
SELECT COUNT(*) AS bad_fk
FROM ecs_accounts a
LEFT JOIN ecs_customers c ON c.customer_id = a.customer_id
WHERE c.customer_id IS NULL;

CREATE TABLE ecs_transactions (
    transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id     INTEGER NOT NULL,
    txn_type       TEXT NOT NULL CHECK (txn_type IN ('DEPOSIT','WITHDRAWAL')),
    amount         REAL NOT NULL CHECK (amount > 0),
    txn_ts         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    description    TEXT,
    FOREIGN KEY (account_id)
      REFERENCES ecs_accounts(account_id) ON DELETE CASCADE
);

CREATE INDEX idx_transactions_account_ts ON ecs_transactions(account_id, txn_ts);

PRAGMA table_info(ecs_transactions);
PRAGMA index_list(ecs_transactions);

SELECT COUNT(*) FROM ecs_customers;
SELECT COUNT(*) FROM ecs_accounts;
SELECT name FROM sqlite_master WHERE type='table' AND name='ecs_transactions';

WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
     nums(n) AS ( SELECT a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 10000 * e.d + 100000 * f.d AS n
                    FROM digits a
                  CROSS JOIN digits b
                  CROSS JOIN digits c
                  CROSS JOIN digits d
                  CROSS JOIN digits e
                  CROSS JOIN digits f )
INSERT INTO ecs_transactions (account_id, txn_type, amount, description)
SELECT (n % 100000) + 1 AS account_id, 
       CASE
         WHEN (n % 3) IN (0, 1) THEN 'DEPOSIT' -- 2/3 deposits
         ELSE 'WITHDRAWAL'                     -- 1/3 withdrawals
       END AS txn_type,
       ((n % 5000) + 1) / 100.0 AS amount,     -- 0.01 .. 50.00
       'Seed txn #' || n
  FROM nums
 WHERE n < 300000;
 
SELECT COUNT(*) AS transactions_count FROM ecs_transactions;

UPDATE ecs_accounts SET balance = 0.0;

UPDATE ecs_accounts
  SET balance = ( SELECT COALESCE (SUM ( CASE txn_type
                                           WHEN 'DEPOSIT' THEN amount
                                           WHEN 'WITHDRAWAL' THEN -amount
                                         END ), 0.0)
                    FROM ecs_transactions t
                   WHERE t.account_id = ecs_accounts.account_id );

-- Any account missing from the ledger should still have 0.0 balance
SELECT COUNT(*) AS accounts_with_zero_balance FROM ecs_accounts WHERE balance = 0.0;

-- Quick sanity: distribution
SELECT MIN(balance) AS min_balance, MAX(balance) AS max_balance, AVG(balance) AS avg_balance
  FROM ecs_accounts;

-- Reconciliation test on a random-looking account
SELECT a.account_id, 
       a.balance AS stored_balance,
       ( SELECT COALESCE (SUM (CASE txn_type WHEN 'DEPOSIT' THEN amount ELSE -amount END), 0.0)
           FROM ecs_transactions t
          WHERE t.account_id = a.account_id ) AS computed_balance
  FROM ecs_accounts a
 WHERE a.account_id = 4242;
 
CREATE TRIGGER trg_accounts_no_negative_balance
BEFORE UPDATE OF balance ON ecs_accounts
FOR EACH ROW
WHEN NEW.balance < 0
BEGIN
  SELECT RAISE(ABORT, 'Insufficient funds: balance cannot go negative');
END;

-- UPDATE ecs_accounts SET balance = -1 WHERE account_id = 1;
SELECT account_id, balance FROM ecs_accounts WHERE account_id = 1;

INSERT INTO ecs_transactions (account_id, txn_type, amount, description) VALUES (4242, 'DEPOSIT', 25.00, 'Manual deposit');
UPDATE ecs_accounts SET balance = balance + 25.00 WHERE account_id = 4242;

SELECT balance FROM ecs_accounts WHERE account_id = 4242;

SELECT *
FROM ecs_transactions
WHERE account_id = 4242
ORDER BY transaction_id DESC;

INSERT INTO ecs_transactions (account_id, txn_type, amount, description) VALUES (4242, 'WITHDRAWAL', 10.00, 'Manual withdrawal');
UPDATE ecs_accounts SET balance = balance - 10.00 WHERE account_id = 4242;

SELECT balance FROM ecs_accounts WHERE account_id = 4242;

-- debit
INSERT INTO ecs_transactions (account_id, txn_type, amount, description)
VALUES (4242, 'WITHDRAWAL', 12.50, 'Transfer to acct 4243');

UPDATE ecs_accounts
SET balance = balance - 12.50
WHERE account_id = 4242;

-- credit
INSERT INTO ecs_transactions (account_id, txn_type, amount, description)
VALUES (4243, 'DEPOSIT', 12.50, 'Transfer from acct 4242');

UPDATE ecs_accounts
SET balance = balance + 12.50
WHERE account_id = 4243;

SELECT account_id, balance
FROM ecs_accounts
WHERE account_id IN (4242, 4243);

SELECT account_id, txn_type, amount, description, txn_ts
FROM ecs_transactions
WHERE account_id IN (4242, 4243)
ORDER BY transaction_id DESC;

ALTER TABLE ecs_accounts ADD COLUMN account_number TEXT;
UPDATE ecs_accounts
   SET account_number = 'ACCT-' || printf('%010d', account_id)
 WHERE account_number IS NULL;
CREATE UNIQUE INDEX idx_accounts_account_number ON ecs_accounts(account_number);

SELECT COUNT(*) AS null_account_numbers
FROM ecs_accounts
WHERE account_number IS NULL;

SELECT COUNT(DISTINCT account_number) AS distinct_acctnums,
       COUNT(*) AS total_accounts
FROM ecs_accounts;

ALTER TABLE ecs_transactions ADD COLUMN transfer_id TEXT;
CREATE INDEX idx_transactions_transfer_id ON ecs_transactions(transfer_id);

PRAGMA table_info(ecs_transactions);
PRAGMA index_list(ecs_transactions);

-- Make a unique-ish transfer id (timestamp + accounts)
-- (You can also replace this literal with anything unique you like.)
INSERT INTO ecs_transactions (account_id, txn_type, amount, description, transfer_id)
VALUES (4242, 'WITHDRAWAL', 33.33, 'Transfer to acct 4243', 'T-' || strftime('%Y%m%d%H%M%f','now') || '-4242-4243');

UPDATE ecs_accounts
SET balance = balance - 33.33
WHERE account_id = 4242;

INSERT INTO ecs_transactions (account_id, txn_type, amount, description, transfer_id)
SELECT 4243, 'DEPOSIT', 33.33, 'Transfer from acct 4242', transfer_id
FROM ecs_transactions
WHERE transaction_id = last_insert_rowid();

UPDATE ecs_accounts
SET balance = balance + 33.33
WHERE account_id = 4243;

SELECT transfer_id, COUNT(*) AS legs, SUM(CASE txn_type WHEN 'DEPOSIT' THEN amount ELSE -amount END) AS net
  FROM ecs_transactions
 WHERE transfer_id IS NOT NULL
 GROUP BY transfer_id
 ORDER BY transfer_id DESC;
 
CREATE INDEX IF NOT EXISTS idx_accounts_customer_id ON ecs_accounts(customer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON ecs_transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_customers_name ON ecs_customers(last_name, first_name);

PRAGMA index_list(ecs_accounts);
PRAGMA index_list(ecs_customers);
PRAGMA index_list(ecs_transactions);

CREATE TABLE IF NOT EXISTS ecs_transaction_audit (
  audit_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL,
  action         TEXT NOT NULL,                 -- 'INSERT'
  audit_ts       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS trg_transactions_audit_insert
AFTER INSERT ON ecs_transactions
FOR EACH ROW
BEGIN
  INSERT INTO ecs_transaction_audit (transaction_id, action) VALUES (NEW.transaction_id, 'INSERT');
END;

INSERT INTO ecs_transactions (account_id, txn_type, amount, description) VALUES (4242, 'DEPOSIT', 1.11, 'Audit test deposit');
UPDATE ecs_accounts SET balance = balance + 1.11 WHERE account_id = 4242;

SELECT * FROM ecs_transaction_audit ORDER BY audit_id DESC LIMIT 5;

CREATE TRIGGER IF NOT EXISTS trg_no_self_transfer
BEFORE INSERT ON ecs_transactions
FOR EACH ROW
  WHEN     NEW.transfer_id IS NOT NULL
       AND EXISTS ( SELECT 1
                      FROM transactions t
                     WHERE t.transfer_id = NEW.transfer_id
                       AND t.account_id = NEW.account_id )
BEGIN
  SELECT RAISE(ABORT, 'Invalid transfer: duplicate leg for same account');
END;

ANALYZE;
VACUUM;

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

-- ecs_employees definition

CREATE TABLE ecs_employees (
  employee_id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id   INTEGER NOT NULL,
  full_name   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('TELLER','MANAGER','BACKOFFICE')),
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','LEFT')),
  hired_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (branch_id) REFERENCES ecs_branches(branch_id)
);

CREATE INDEX idx_employees_branch ON ecs_employees(branch_id);

WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
     nums(n) AS ( SELECT a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 10000 * e.d AS n
                    FROM digits a
                   CROSS JOIN digits b
                   CROSS JOIN digits c
                   CROSS JOIN digits d
                   CROSS JOIN digits e )
INSERT INTO ecs_employees (branch_id, full_name, "role", status, hired_at)
SELECT 1, 
       'First' || n || ' Last' || n,
       CASE WHEN (n % 2) = 0 THEN CASE WHEN n % 4 = 0 THEN 'TELLER' ELSE 'MANAGER' END ELSE 'BACKOFFICE' END,
       'ACTIVE',
       CASE
         WHEN (n % 2) = 0 THEN CASE WHEN n % 4 = 0 THEN DATETIME ('now', '-10 years') ELSE DATETIME ('now', '-3 years') END
         ELSE                  DATETIME ('now', '-5 years')
       END
  FROM nums
 WHERE n < 400;