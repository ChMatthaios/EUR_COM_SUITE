-- Phase 0 — SQLite session settings
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;

PRAGMA foreign_keys;
PRAGMA journal_mode;

-- Phase 1 — Core reference tables (countries, currencies, branches)
-- Currencies
CREATE TABLE ecs_currencies (
  currency_code TEXT PRIMARY KEY,            -- e.g. 'EUR'
  name          TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  minor_unit    INTEGER NOT NULL DEFAULT 2   -- decimals
);

-- Branches
CREATE TABLE ecs_branches (
  branch_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  city        TEXT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ecs_currencies','ecs_branches');

-- Phase 2 — Parties (customers), contacts, addresses, IDs (KYC)
-- Parties (customer/person)
CREATE TABLE ecs_parties (
  party_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  party_type   TEXT NOT NULL CHECK (party_type IN ('PERSON','BUSINESS')),
  full_name    TEXT NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','CLOSED'))
);

-- Person details (only when party_type = PERSON)
CREATE TABLE ecs_person_details (
  party_id      INTEGER PRIMARY KEY,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  date_of_birth DATE,
  tax_id        TEXT,
  FOREIGN KEY (party_id) REFERENCES ecs_parties(party_id) ON DELETE CASCADE
);

-- Addresses
CREATE TABLE ecs_addresses (
  address_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  line1       TEXT NOT NULL,
  line2       TEXT,
  city        TEXT NOT NULL,
  region      TEXT,
  postal_code TEXT,
  country     TEXT NOT NULL
);

CREATE TABLE ecs_party_addresses (
  party_id    INTEGER NOT NULL,
  address_id  INTEGER NOT NULL,
  addr_type   TEXT NOT NULL CHECK (addr_type IN ('HOME','WORK','MAILING')),
  is_primary  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  PRIMARY KEY (party_id, address_id),
  FOREIGN KEY (party_id) REFERENCES ecs_parties(party_id) ON DELETE CASCADE,
  FOREIGN KEY (address_id) REFERENCES ecs_addresses(address_id) ON DELETE CASCADE
);

-- Contacts
CREATE TABLE ecs_party_contacts (
  contact_id INTEGER PRIMARY KEY AUTOINCREMENT,
  party_id   INTEGER NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('EMAIL','PHONE')),
  value      TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  UNIQUE(party_id, type, value),
  FOREIGN KEY (party_id) REFERENCES ecs_parties(party_id) ON DELETE CASCADE
);


-- Identity documents (KYC)
CREATE TABLE ecs_party_id_documents (
  doc_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  party_id   INTEGER NOT NULL,
  doc_type   TEXT NOT NULL CHECK (doc_type IN ('PASSPORT','NATIONAL_ID','DRIVER_LICENSE')),
  doc_number TEXT NOT NULL,
  issued_by  TEXT,
  expires_on DATE,
  UNIQUE(doc_type, doc_number),
  FOREIGN KEY (party_id) REFERENCES ecs_parties(party_id) ON DELETE CASCADE
);

SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ecs_party_%';

-- Phase 3 — Products + Accounts (joint holders) + “no overdraft” controls
-- Deposit products (checking/savings)
CREATE TABLE ecs_deposit_products (
  product_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  currency_code   TEXT NOT NULL,
  overdraft_allowed INTEGER NOT NULL DEFAULT 0 CHECK (overdraft_allowed IN (0,1)),
  overdraft_limit REAL NOT NULL DEFAULT 0.0,
  FOREIGN KEY (currency_code) REFERENCES ecs_currencies(currency_code)
);

-- Accounts
ALTER TABLE ecs_accounts ADD COLUMN brach_id INTEGER;
ALTER TABLE ecs_accounts ADD COLUMN product_id INTEGER;
ALTER TABLE ecs_accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','FROZEN','CLOSED'));

-- Joint holders + roles
CREATE TABLE ecs_account_holders (
  account_id   INTEGER NOT NULL,
  party_id     INTEGER NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('PRIMARY','JOINT','AUTHORIZED')),
  added_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, party_id),
  FOREIGN KEY (account_id) REFERENCES ecs_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (party_id) REFERENCES ecs_parties(party_id) ON DELETE CASCADE
);


SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ecs_deposit_products','ecs_accounts','ecs_account_holders');


-- Phase 4 — Realistic money movement: Double-entry ledger (the heart of a real bank)
-- Chart of accounts (GL)
CREATE TABLE ecs_gl_accounts (
  gl_account_id INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,           -- e.g. 1010
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('ASSET','LIABILITY','INCOME','EXPENSE','EQUITY')),
  currency_code TEXT NOT NULL,
  FOREIGN KEY (currency_code) REFERENCES ecs_currencies(currency_code)
);

-- Journal entries
CREATE TABLE ecs_journal_entries (
  entry_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_ts     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source       TEXT NOT NULL,                   -- 'DEPOSIT','WITHDRAWAL','TRANSFER','FEE','LOAN'
  reference    TEXT,                            -- external reference / correlation id
  status       TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
  memo         TEXT
);

-- Ledger lines (each entry has many lines) {
--   Either gl_account_id is set (GL), 
--   Or account_id is set (customer account), 
--   Both can be set too if you want mapping, but we’ll keep it clean: one side per line.
-- }
CREATE TABLE ecs_ledger_lines (
  line_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id     INTEGER NOT NULL,
  account_id   INTEGER,                         -- customer account (sub-ledger)
  gl_account_id INTEGER,                        -- GL account
  currency_code TEXT NOT NULL,
  debit        REAL NOT NULL DEFAULT 0.0 CHECK (debit >= 0),
  credit       REAL NOT NULL DEFAULT 0.0 CHECK (credit >= 0),
  description  TEXT,
  CHECK (NOT (debit > 0 AND credit > 0)),
  CHECK (debit > 0 OR credit > 0),
  FOREIGN KEY (entry_id) REFERENCES ecs_journal_entries(entry_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES ecs_accounts(account_id),
  FOREIGN KEY (gl_account_id) REFERENCES ecs_gl_accounts(gl_account_id),
  FOREIGN KEY (currency_code) REFERENCES ecs_currencies(currency_code)
);

CREATE INDEX idx_ledger_lines_entry ON ecs_ledger_lines(entry_id);
CREATE INDEX idx_ledger_lines_account ON ecs_ledger_lines(account_id);
CREATE INDEX idx_ledger_lines_gl ON ecs_ledger_lines(gl_account_id);

-- Enforce balanced entries (trigger)
CREATE TRIGGER trg_ledger_entry_must_balance
AFTER INSERT ON ecs_ledger_lines
FOR EACH ROW
BEGIN
  -- if entry is POSTED, enforce that total debits == total credits for that entry
  SELECT CASE
           WHEN ( SELECT status
                    FROM ecs_journal_entries
                   WHERE entry_id = NEW.entry_id) = 'POSTED'
                     AND ( SELECT ROUND(COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0), 6)
                             FROM ecs_ledger_lines
                            WHERE entry_id = NEW.entry_id ) NOT IN (0.0) THEN
             RAISE(ABORT, 'Journal entry not balanced (debits != credits)')
         END;
END;

DROP TRIGGER IF EXISTS trg_ledger_entry_must_balance;
CREATE TRIGGER trg_posting_requires_balance
BEFORE UPDATE OF status ON ecs_journal_entries
FOR EACH ROW WHEN NEW.status = 'POSTED'
BEGIN
  SELECT CASE
           WHEN ( SELECT ROUND(COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0), 6)
                    FROM ecs_ledger_lines
                   WHERE entry_id = NEW.entry_id ) <> 0.0 THEN
             RAISE(ABORT, 'Cannot POST: journal entry not balanced')
         END;
END;

SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_posting_requires_balance';

-- Phase 5 — Derived balances + overdraft enforcement (realistic)
-- View: account balance from ledger
CREATE VIEW v_account_balances
AS
  SELECT a.account_id,
         a.account_number,
         dp.currency_code,
         ROUND (COALESCE (SUM (ll.debit - ll.credit),0), 2) AS balance
    FROM ecs_accounts a
    JOIN ecs_deposit_products dp ON dp.product_id = a.product_id
    LEFT JOIN ecs_ledger_lines ll ON ll.account_id = a.account_id
    LEFT JOIN ecs_journal_entries je ON je.entry_id = ll.entry_id AND je.status='POSTED'
   WHERE (ll.entry_id IS NULL OR je.status='POSTED')
   GROUP BY a.account_id;

-- Trigger: block posting withdrawals/transfers that overdraft
CREATE TRIGGER trg_no_overdraft_on_post
BEFORE UPDATE OF status ON ecs_journal_entries
FOR EACH ROW WHEN NEW.status = 'POSTED'
BEGIN
  -- For each customer account credited in this entry:
  SELECT CASE
           WHEN EXISTS ( SELECT 1
                           FROM ecs_ledger_lines ll
                           JOIN ecs_accounts a ON a.account_id = ll.account_id
                           JOIN ecs_deposit_products dp ON dp.product_id = a.product_id
                          WHERE ll.entry_id = NEW.entry_id
                            AND ll.account_id IS NOT NULL
                            AND ll.credit > 0
                            AND ( -- current balance (posted only)
                                    ( SELECT COALESCE(SUM(debit - credit), 0)
                                        FROM ecs_ledger_lines x
                                        JOIN ecs_journal_entries jx ON jx.entry_id = x.entry_id
                                       WHERE x.account_id = ll.account_id
                                         AND jx.status = 'POSTED' )
                                  + -- apply this entry’s net effect on that account
                                    ( SELECT COALESCE(SUM(debit - credit), 0)
                                        FROM ecs_ledger_lines y
                                       WHERE y.entry_id = NEW.entry_id
                                         AND y.account_id = ll.account_id )
                                  < -(CASE WHEN dp.overdraft_allowed = 1 THEN dp.overdraft_limit ELSE 0 END))) THEN
             RAISE(ABORT, 'Insufficient funds: overdraft limit exceeded')
           END;
END;

SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('trg_no_overdraft_on_post','trg_posting_requires_balance');

-- Phase 6 — Operational scripts (deposit / withdrawal / transfer) using ledger
-- Setup: create minimal GL accounts for cash and customer deposits
INSERT OR IGNORE INTO ecs_currencies(currency_code,name,symbol,minor_unit) VALUES ('EUR','Euro','€',2);

INSERT OR IGNORE INTO ecs_gl_accounts(code,name,type,currency_code)
VALUES ('1000','Cash on Hand','ASSET','EUR'),
       ('2000','Customer Deposits','LIABILITY','EUR');

SELECT * FROM ecs_gl_accounts;

-- Deposit into a customer account (example)
BEGIN;

INSERT INTO ecs_journal_entries(status, source, reference, memo)
VALUES ('REVERSED', 'DEPOSIT', 'REF-DEP-001', 'Cash deposit');
SELECT last_insert_rowid() AS entry_id;

-- Line 1: Debit Cash (asset increases)
INSERT INTO ecs_ledger_lines(entry_id, gl_account_id, currency_code, debit, credit, description)
VALUES ((SELECT MAX(entry_id) FROM ecs_journal_entries), (SELECT gl_account_id FROM ecs_gl_accounts WHERE code='1000'), 'EUR', 50.00, 0.0, 'Cash received');

-- Line 2: Credit Customer account (liability increases from bank perspective; customer balance increases in our view via debit-credit)
-- Our balance view uses (debit-credit). For customer deposit accounts, we want deposits to INCREASE balance:
-- So we record DEBIT to customer account for deposits, CREDIT for withdrawals/transfers out.
INSERT INTO ecs_ledger_lines(entry_id, account_id, currency_code, debit, credit, description)
VALUES ((SELECT MAX(entry_id) FROM ecs_journal_entries), 4242, 'EUR', 50.00, 0.0, 'Deposit to customer');

-- Offset into Customer Deposits GL (liability): CREDIT (bank owes more)
INSERT INTO ecs_ledger_lines(entry_id, gl_account_id, currency_code, debit, credit, description)
VALUES ((SELECT MAX(entry_id) FROM ecs_journal_entries), (SELECT gl_account_id FROM ecs_gl_accounts WHERE code='2000'), 'EUR', 0.0, 50.00, 'Increase deposit liability');

-- To keep entry balanced, we should not have 3 lines unless balanced:
-- We currently have: debit 1000:50 + debit acct:50, credit 2000:50 => unbalanced.
-- Realistic mapping is either:
-- A) Only two lines: Debit Cash, Credit Customer Deposits GL; and sub-ledger separately.
-- B) Or keep sub-ledger + GL in same table but lines must balance.
-- We’ll do B properly by mirroring:
-- Deposit: Debit Cash 50, Credit Customer Deposits 50 (GL)
-- AND also Debit Customer Account 50, Credit Customer Deposits 50 (internal mapping)
-- That doubles credits, so we need a “bridge” GL. Instead, we separate sub-ledger from GL.

ROLLBACK;

SELECT * FROM ecs_ledger_lines;

-- Phase 7 — Correct separation: GL ledger vs customer postings (recommended)
-- Create customer postings table
CREATE TABLE ecs_account_postings (
  posting_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id     INTEGER NOT NULL,
  account_id   INTEGER NOT NULL,
  currency_code TEXT NOT NULL,
  amount       REAL NOT NULL,                 -- +in, -out (customer perspective)
  posting_ts   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  description  TEXT,
  FOREIGN KEY (entry_id) REFERENCES ecs_journal_entries(entry_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES ecs_accounts(account_id),
  FOREIGN KEY (currency_code) REFERENCES ecs_currencies(currency_code)
);

CREATE INDEX idx_postings_account ON ecs_account_postings(account_id);
CREATE INDEX idx_postings_entry ON ecs_account_postings(entry_id);

-- Replace account balance view (from postings)
DROP VIEW IF EXISTS v_account_balances;

CREATE VIEW v_account_balances
AS
  SELECT a.account_id,
         a.account_number,
         dp.currency_code,
         ROUND(COALESCE(SUM(p.amount),0), 2) AS balance
    FROM ecs_accounts a
    JOIN ecs_deposit_products dp ON dp.product_id = a.product_id
    LEFT JOIN ecs_account_postings p ON p.account_id = a.account_id
    LEFT JOIN ecs_journal_entries je ON je.entry_id = p.entry_id AND je.status='POSTED'
   WHERE (p.entry_id IS NULL OR je.status='POSTED')
   GROUP BY a.account_id;

-- Posting-time overdraft trigger (on POST)
DROP TRIGGER IF EXISTS trg_no_overdraft_on_post;

CREATE TRIGGER trg_no_overdraft_on_post
BEFORE UPDATE OF status ON ecs_journal_entries
FOR EACH ROW WHEN NEW.status='POSTED'
BEGIN
  SELECT CASE
           WHEN EXISTS ( SELECT 1
                           FROM ecs_account_postings ap
                           JOIN ecs_accounts a ON a.account_id = ap.account_id
                           JOIN ecs_deposit_products dp ON dp.product_id = a.product_id
                          WHERE ap.entry_id = NEW.entry_id
                            AND (   ( SELECT COALESCE(SUM(p.amount),0)
                                        FROM ecs_account_postings p
                                        JOIN ecs_journal_entries j ON j.entry_id = p.entry_id
                                       WHERE p.account_id = ap.account_id AND j.status='POSTED' )
                                  + ( SELECT COALESCE(SUM(p2.amount),0)
                                        FROM ecs_account_postings p2
                                       WHERE p2.entry_id = NEW.entry_id AND p2.account_id = ap.account_id )
                                  < -(CASE WHEN dp.overdraft_allowed=1 THEN dp.overdraft_limit ELSE 0 END))) THEN
             RAISE(ABORT, 'Insufficient funds: overdraft limit exceeded')
           END;
END;

SELECT name FROM sqlite_master WHERE type='table' AND name='ecs_account_postings';
SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('trg_posting_requires_balance','trg_no_overdraft_on_post');

-- Phase 8 — Working operational scripts (now truly correct)
-- Deposit (cash deposit): GL + postings + POST {Example: deposit 25.00 EUR to account 4242.}
INSERT INTO ecs_journal_entries(status, source, reference, memo)
VALUES ('REVERSED','DEPOSIT','DEP-'||strftime('%Y%m%d%H%M%f','now'),'Cash deposit');
SELECT last_insert_rowid() AS eid;

-- GL: Debit Cash, Credit Customer Deposits (balanced)
INSERT INTO ecs_ledger_lines(entry_id, gl_account_id, currency_code, debit, credit, description)
VALUES
(3, (SELECT gl_account_id FROM ecs_gl_accounts WHERE code='1000'), 'EUR', 25.00, 0.0, 'Cash received'),
(3, (SELECT gl_account_id FROM ecs_gl_accounts WHERE code='2000'), 'EUR', 0.0, 25.00, 'Increase deposits liability');

-- Customer posting: +25 to account
INSERT INTO ecs_account_postings(entry_id, account_id, currency_code, amount, description)
VALUES (3, 4242, 'EUR', 25.00, 'Deposit');

-- POST (checks: GL balanced + overdraft ok)
UPDATE ecs_journal_entries SET status='POSTED' WHERE entry_id=3;

-- Withdrawal (cash withdrawal): GL + postings + POST
INSERT INTO ecs_journal_entries(status, source, reference, memo)
VALUES ('REVERSED','WITHDRAWAL','WDR-'||strftime('%Y%m%d%H%M%f','now'),'Cash withdrawal');
SELECT last_insert_rowid() AS eid;

-- GL: Credit Cash, Debit Customer Deposits (balanced)
INSERT INTO ecs_ledger_lines(entry_id, gl_account_id, currency_code, debit, credit, description)
VALUES
(4, (SELECT gl_account_id FROM ecs_gl_accounts WHERE code='2000'), 'EUR', 25.00, 0.0, 'Reduce deposits liability'),
(4, (SELECT gl_account_id FROM ecs_gl_accounts WHERE code='1000'), 'EUR', 0.0, 25.00, 'Cash paid out');

-- Customer posting: -25 from account (overdraft enforced on POST)
INSERT INTO ecs_account_postings(entry_id, account_id, currency_code, amount, description)
VALUES (4, 4242, 'EUR', -25.00, 'Withdrawal');

UPDATE ecs_journal_entries SET status='POSTED' WHERE entry_id=4;

-- Transfer (account→account): postings move money, GL unchanged (still realistic)
INSERT INTO ecs_journal_entries(status, source, reference, memo)
VALUES ('REVERSED','TRANSFER','TRF-'||strftime('%Y%m%d%H%M%f','now'),'Internal transfer');
SELECT last_insert_rowid() AS eid;

INSERT INTO ecs_account_postings(entry_id, account_id, currency_code, amount, description)
VALUES
(5, 4242, 'EUR', -12.50, 'Transfer out'),
(5, 4243, 'EUR', +12.50, 'Transfer in');

UPDATE ecs_journal_entries SET status='POSTED' WHERE entry_id=5;

-- Checkpoint
SELECT a.account_id,
       a.account_number,
       dp.currency_code,
       ROUND(COALESCE(SUM(p.amount),0), 2) AS balance
  FROM ecs_accounts a
  LEFT JOIN ecs_deposit_products dp ON dp.product_id = a.product_id
  LEFT JOIN ecs_account_postings p ON p.account_id = a.account_id
  LEFT JOIN ecs_journal_entries je ON je.entry_id = p.entry_id AND je.status='POSTED'
 WHERE a.account_id IN (4242,4243)
 GROUP BY a.account_id;

SELECT entry_id, source, status, reference, entry_ts
FROM ecs_journal_entries
ORDER BY entry_id DESC
LIMIT 10;