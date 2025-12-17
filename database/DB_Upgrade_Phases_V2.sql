-- STEP 9 — Make posted data immutable (realistic control)
-- Block editing/deleting POSTED journal entries
CREATE TRIGGER IF NOT EXISTS trg_no_delete_posted_entries
BEFORE DELETE ON ecs_journal_entries
FOR EACH ROW WHEN OLD.status = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'Cannot delete POSTED journal entry');
END;

CREATE TRIGGER IF NOT EXISTS trg_no_update_posted_entries
BEFORE UPDATE ON ecs_journal_entries
FOR EACH ROW WHEN OLD.status = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'Cannot update POSTED journal entry');
END;

-- Block editing/deleting ledger lines of POSTED entries
CREATE TRIGGER IF NOT EXISTS trg_no_delete_posted_ledger_lines
BEFORE DELETE ON ecs_ledger_lines
FOR EACH ROW WHEN ( SELECT status
                      FROM ecs_journal_entries
                     WHERE entry_id = OLD.entry_id )= 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'Cannot delete ledger line of POSTED entry');
END;

CREATE TRIGGER IF NOT EXISTS trg_no_update_posted_ledger_lines
BEFORE UPDATE ON ecs_ledger_lines
FOR EACH ROW WHEN ( SELECT status
                      FROM ecs_journal_entries
                     WHERE entry_id = OLD.entry_id )= 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'Cannot update ledger line of POSTED entry');
END;

-- Block editing/deleting account postings of POSTED entries
CREATE TRIGGER IF NOT EXISTS trg_no_delete_posted_account_postings
BEFORE DELETE ON ecs_account_postings
FOR EACH ROW WHEN ( SELECT status
                      FROM ecs_journal_entries
                     WHERE entry_id = OLD.entry_id )= 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'Cannot delete account posting of POSTED entry');
END;

CREATE TRIGGER IF NOT EXISTS trg_no_update_posted_account_postings
BEFORE UPDATE ON ecs_account_postings
FOR EACH ROW WHEN ( SELECT status
                      FROM ecs_journal_entries
                     WHERE entry_id = OLD.entry_id )= 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'Cannot update account posting of POSTED entry');
END;

SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_no_%posted%';

-- STEP 10 — Employees + teller operations (realistic branch ops)
-- Employees
CREATE TABLE ecs_employees (
  employee_id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id   INTEGER NOT NULL,
  full_name   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('TELLER','MANAGER','BACKOFFICE')),
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','LEFT')),
  hired_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (branch_id) REFERENCES ecs_branches(branch_id)
);

CREATE INDEX IF NOT EXISTS idx_employees_branch ON ecs_employees(branch_id);

-- STEP 11 — Cards, Authorizations, Settlements (works like real payments)
-- Cards linked to deposit accounts
CREATE TABLE ecs_cards (
  card_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL,
  pan_last4   TEXT NOT NULL,
  card_type   TEXT NOT NULL CHECK (card_type IN ('DEBIT')),
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','EXPIRED','CLOSED')),
  issued_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_on  DATE,
  FOREIGN KEY (account_id) REFERENCES ecs_accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_cards_account ON ecs_cards(account_id);

-- Card authorizations (holds)
CREATE TABLE ecs_card_authorizations (
  auth_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     INTEGER NOT NULL,
  account_id  INTEGER NOT NULL,
  amount      REAL NOT NULL CHECK (amount > 0),
  merchant    TEXT NOT NULL,
  auth_ts     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status      TEXT NOT NULL DEFAULT 'APPROVED'
              CHECK (status IN ('APPROVED','REVERSED','EXPIRED','CAPTURED')),
  reference   TEXT NOT NULL UNIQUE,
  FOREIGN KEY (card_id) REFERENCES ecs_cards(card_id),
  FOREIGN KEY (account_id) REFERENCES ecs_accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_account_status ON ecs_card_authorizations(account_id, status);
CREATE INDEX IF NOT EXISTS idx_auth_card ON ecs_card_authorizations(card_id);

-- Settlements (capture an auth into a POSTED journal entry)
CREATE TABLE ecs_card_settlements (
  settlement_id INTEGER PRIMARY KEY AUTOINCREMENT,
  auth_id       INTEGER NOT NULL UNIQUE,
  entry_id      INTEGER NOT NULL UNIQUE,
  settled_ts    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (auth_id) REFERENCES ecs_card_authorizations(auth_id),
  FOREIGN KEY (entry_id) REFERENCES ecs_journal_entries(entry_id)
);

-- STEP 12 — Loans (origination, schedule, payments, interest income)
-- Loan products
CREATE TABLE ecs_loan_products (
  loan_product_id INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  apr             REAL NOT NULL CHECK (apr >= 0),    -- annual percentage rate
  term_months     INTEGER NOT NULL CHECK (term_months > 0)
);

-- Loans
CREATE TABLE ecs_loans (
  loan_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  party_id       INTEGER NOT NULL,
  branch_id      INTEGER NOT NULL,
  loan_product_id INTEGER NOT NULL,
  principal      REAL NOT NULL CHECK (principal > 0),
  apr            REAL NOT NULL CHECK (apr >= 0),
  term_months    INTEGER NOT NULL CHECK (term_months > 0),
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PENDING','ACTIVE','CLOSED','DEFAULT')),
  originated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (party_id) REFERENCES ecs_parties(party_id),
  FOREIGN KEY (branch_id) REFERENCES ecs_branches(branch_id),
  FOREIGN KEY (loan_product_id) REFERENCES ecs_loan_products(loan_product_id)
);

CREATE INDEX IF NOT EXISTS idx_loans_party ON ecs_loans(party_id);

-- Amortization schedule (simplified storage)
CREATE TABLE ecs_loan_schedule (
  schedule_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id       INTEGER NOT NULL,
  installment_no INTEGER NOT NULL,
  due_date      DATE NOT NULL,
  due_principal REAL NOT NULL DEFAULT 0 CHECK (due_principal >= 0),
  due_interest  REAL NOT NULL DEFAULT 0 CHECK (due_interest >= 0),
  status        TEXT NOT NULL DEFAULT 'DUE' CHECK (status IN ('DUE','PAID')),
  UNIQUE(loan_id, installment_no),
  FOREIGN KEY (loan_id) REFERENCES ecs_loans(loan_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_loan_schedule_loan ON ecs_loan_schedule(loan_id);

-- Loan payments (ties to a posted journal entry)
CREATE TABLE ecs_loan_payments (
  payment_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id      INTEGER NOT NULL,
  entry_id     INTEGER NOT NULL UNIQUE,
  paid_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  amount       REAL NOT NULL CHECK (amount > 0),
  FOREIGN KEY (loan_id) REFERENCES ecs_loans(loan_id),
  FOREIGN KEY (entry_id) REFERENCES ecs_journal_entries(entry_id)
);

CREATE INDEX IF NOT EXISTS idx_loan_payments_loan ON ecs_loan_payments(loan_id);

SELECT name
  FROM sqlite_master
 WHERE type = 'table'
   AND name IN ('ecs_loan_products', 'ecs_loans', 'ecs_loan_schedule', 'ecs_loan_payments');

-- STEP 13 — Fees (monthly maintenance, overdraft fees)
-- Fee definitions
CREATE TABLE ecs_fee_types (
  fee_type_id INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  amount      REAL NOT NULL CHECK (amount >= 0)
);

-- Applied fees (each becomes a posted journal entry)
CREATE TABLE ecs_fees_applied (
  fee_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  fee_type_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  entry_id   INTEGER NOT NULL UNIQUE,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (fee_type_id) REFERENCES ecs_fee_types(fee_type_id),
  FOREIGN KEY (account_id) REFERENCES ecs_accounts(account_id),
  FOREIGN KEY (entry_id) REFERENCES ecs_journal_entries(entry_id)
);

CREATE INDEX IF NOT EXISTS idx_fees_account ON ecs_fees_applied(account_id);

-- STEP 14 — Compliance / fraud flags (realistic ops layer)
CREATE TABLE ecs_compliance_flags (
  flag_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  party_id    INTEGER,
  account_id  INTEGER,
  severity    TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH')),
  category    TEXT NOT NULL,   -- e.g. 'KYC','AML','FRAUD'
  note        TEXT,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  FOREIGN KEY (party_id) REFERENCES ecs_parties(party_id),
  FOREIGN KEY (account_id) REFERENCES ecs_accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_flags_party ON ecs_compliance_flags(party_id);
CREATE INDEX IF NOT EXISTS idx_flags_account ON ecs_compliance_flags(account_id);

-- STEP 15 — Seed realistic master data (minimal) so scripts work
INSERT OR IGNORE INTO ecs_branches(code,name,city) VALUES ('ATH-001','Athens Central','Athens');

INSERT OR IGNORE INTO ecs_deposit_products(code,name,currency_code,overdraft_allowed,overdraft_limit)
VALUES
('CHK-EUR','Checking EUR','EUR',0,0.0),
('SAV-EUR','Savings EUR','EUR',0,0.0);

INSERT OR IGNORE INTO ecs_fee_types(code,name,amount)
VALUES
('MONTHLY','Monthly account maintenance',2.50),
('ODF','Overdraft fee',15.00);

INSERT OR IGNORE INTO ecs_loan_products(code,name,apr,term_months)
VALUES
('LN-STD-36','Standard Loan 36m',0.085,36),
('LN-STD-60','Standard Loan 60m',0.095,60);

-- GL accounts for loans + interest + fees
INSERT OR IGNORE INTO ecs_gl_accounts(code,name,type,currency_code) VALUES
('1100','Loan Receivables','ASSET','EUR'),
('4000','Interest Income','INCOME','EUR'),
('4010','Fee Income','INCOME','EUR');

SELECT code,name FROM ecs_deposit_products;
SELECT code,name FROM ecs_loan_products;
SELECT code,name FROM ecs_fee_types;
SELECT code,name FROM ecs_gl_accounts ORDER BY code;

-- STEP 16 — Fully working operational scripts (cards + loans + fees)
-- Create a debit card for an existing account (example account_id = 4242)
INSERT INTO ecs_cards(account_id, pan_last4, card_type, status, expires_on)
VALUES (4242, '4242', 'DEBIT', 'ACTIVE', date('now','+3 years'));

SELECT * FROM ecs_cards WHERE account_id=4242 ORDER BY card_id DESC LIMIT 1;

-- Card authorization (hold) with available-funds check (simple)
-- v_account_balances source
CREATE VIEW v_account_balances
AS
  SELECT a.account_id,
         a.account_number,
         dp.currency_code,
         ROUND(COALESCE(SUM(p.amount),0), 2) AS balance,
         CASE WHEN (p.entry_id IS NULL OR je.status='POSTED') THEN 'YES' ELSE 'NO' END AS Verdict
    FROM ecs_accounts a
    LEFT JOIN ecs_deposit_products dp ON dp.product_id = a.product_id
    LEFT JOIN ecs_account_postings p ON p.account_id = a.account_id
    LEFT JOIN ecs_journal_entries je ON je.entry_id = p.entry_id AND je.status='POSTED'
   GROUP BY a.account_id;

CREATE VIEW IF NOT EXISTS v_account_available
AS
  SELECT b.account_id,
         b.account_number,
         b.balance,
         ROUND(   b.balance
                - COALESCE(( SELECT SUM(a.amount)
                               FROM ecs_card_authorizations a
                              WHERE a.account_id = b.account_id
                                AND a.status = 'APPROVED' ),0), 2
         ) AS available
    FROM v_account_balances b;

INSERT INTO ecs_card_authorizations(card_id, account_id, amount, merchant, reference)
SELECT
  (SELECT card_id FROM ecs_cards WHERE account_id=4242 ORDER BY card_id DESC LIMIT 1),
  4242,
  5.55,
  'Coffee Shop',
  'AUTH-' || strftime('%Y%m%d%H%M%f','now');

SELECT * FROM v_account_available WHERE account_id=4242;
SELECT * FROM ecs_card_authorizations WHERE account_id=4242 ORDER BY auth_id DESC LIMIT 3;

-- Capture (settlement): turns auth into a posted TRANSFER OUT (posting -amount)
-- pick latest approved auth for account 4242
CREATE TEMPORARY TABLE a AS
SELECT auth_id, account_id, amount, merchant, reference
  FROM ecs_card_authorizations
 WHERE account_id = 4242
   AND status = 'APPROVED'
 ORDER BY auth_id DESC
 LIMIT 1;

INSERT INTO ecs_journal_entries(status, source, reference, memo)
SELECT 'REVERSED', 'CARD', 'CAP-' || reference, 'Card settlement: ' || merchant
FROM a;

-- posting (money leaves customer account)
INSERT INTO ecs_account_postings(entry_id, account_id, currency_code, amount, description)
SELECT(SELECT MAX(entry_id) FROM ecs_journal_entries), account_id, 'EUR',-amount, 'Card settlement'
FROM a;

-- GL: debit Customer Deposits (liability down), credit Fee/Clearing (use 4010 or create a clearing acct if you want)
INSERT INTO ecs_ledger_lines(entry_id, gl_account_id, currency_code, debit, credit, description)
VALUES ((SELECT MAX(entry_id) FROM ecs_journal_entries),
		(SELECT gl_account_id FROM ecs_gl_accounts WHERE code = '2000'),
		'EUR',
		(SELECT amount FROM a), 
		0.0, 
		'Reduce deposits (card settlement)'),
	   ((SELECT MAX(entry_id) FROM ecs_journal_entries),
	    (SELECT gl_account_id FROM ecs_gl_accounts WHERE code = '4010'), 
		'EUR', 
		0.0,
		(SELECT amount FROM a),
		'Card settlement income/clearing');
		
-- POST (overdraft trigger applies)
UPDATE ecs_journal_entries
   SET status = 'POSTED'
 WHERE entry_id =(SELECT MAX(entry_id) FROM ecs_journal_entries);
 
-- mark auth captured + link settlement
UPDATE ecs_card_authorizations
   SET status = 'CAPTURED'
 WHERE auth_id =(SELECT auth_id FROM a);

INSERT INTO ecs_card_settlements(auth_id, entry_id)
SELECT(SELECT auth_id FROM a),(SELECT MAX(entry_id) FROM ecs_journal_entries);

DROP TABLE a;

SELECT * FROM ecs_card_settlements ORDER BY settlement_id DESC LIMIT 3;
SELECT * FROM v_account_available WHERE account_id=4242;

-- Loan origination (disburse principal into a deposit account)
INSERT INTO ecs_loans(party_id, branch_id, loan_product_id, principal, apr, term_months, status)
VALUES (
  1,
  (SELECT branch_id FROM ecs_branches WHERE code='ATH-001'),
  (SELECT loan_product_id FROM ecs_loan_products WHERE code='LN-STD-36'),
  1000.00,
  (SELECT apr FROM ecs_loan_products WHERE code='LN-STD-36'),
  (SELECT term_months FROM ecs_loan_products WHERE code='LN-STD-36'),
  'ACTIVE'
);

INSERT INTO ecs_journal_entries(status, source, reference, memo)
VALUES ('REVERSED','LOAN','ORG-'||strftime('%Y%m%d%H%M%f','now'),'Loan disbursement');

-- Customer posting: +principal into deposit account
INSERT INTO ecs_account_postings(entry_id, account_id, currency_code, amount, description)
VALUES ((SELECT MAX(entry_id) FROM ecs_journal_entries), 4242, 'EUR', 1000.00, 'Loan disbursement');

-- GL: Debit Loan Receivable (asset up), Credit Customer Deposits (liability up)
INSERT INTO ecs_ledger_lines(entry_id, gl_account_id, currency_code, debit, credit, description)
VALUES
((SELECT MAX(entry_id) FROM ecs_journal_entries), (SELECT gl_account_id FROM ecs_gl_accounts WHERE code='1100'), 'EUR', 1000.00, 0.0, 'Loan receivable originated'),
((SELECT MAX(entry_id) FROM ecs_journal_entries), (SELECT gl_account_id FROM ecs_gl_accounts WHERE code='2000'), 'EUR', 0.0, 1000.00, 'Deposit liability from loan disbursement');

UPDATE ecs_journal_entries SET status='POSTED' WHERE entry_id=(SELECT MAX(entry_id) FROM ecs_journal_entries);

SELECT * FROM ecs_loans ORDER BY loan_id DESC LIMIT 1;
SELECT * FROM v_account_balances WHERE account_id=4242;

-- STEP 17 — BIG DATA seeding (>100K per new table)
-- Seed 120,000 cards (spread across first 120k accounts)
WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
     nums(n) AS ( SELECT a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 10000 * e.d + 100000 * f.d AS n
                    FROM digits a
                   CROSS JOIN digits b
                   CROSS JOIN digits c
                   CROSS JOIN digits d
                   CROSS JOIN digits e
                   CROSS JOIN digits f )
INSERT INTO ecs_cards(account_id, pan_last4, card_type, status, expires_on)
SELECT (n % 100000) + 1, printf('%04d',(n % 10000)), 'DEBIT', 'ACTIVE', date('now', '+3 years')
  FROM nums
 WHERE n < 120000;

-- Seed 250,000 card authorizations
WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
     nums(n) AS ( SELECT a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 10000 * e.d + 100000 * f.d AS n
                    FROM digits a
                   CROSS JOIN digits b
                   CROSS JOIN digits c
                   CROSS JOIN digits d
                   CROSS JOIN digits e
                   CROSS JOIN digits f )
INSERT INTO ecs_card_authorizations(card_id, account_id, amount, merchant, status, reference)
SELECT (n % (SELECT MAX(card_id) FROM ecs_cards)) + 1,
       (n % 100000) + 1,
       ((n % 5000) + 1) / 100.0,
       'Merchant ' || (n % 5000),
       CASE WHEN (n % 10)=0 THEN 'REVERSED' WHEN (n % 10)=1 THEN 'EXPIRED' ELSE 'APPROVED' END,
       'AUTH-SEED-' || n
  FROM nums
 WHERE n < 250000;

-- Seed 120,000 parties
WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
nums(n) AS (
  SELECT a.d + 10*b.d + 100*c.d + 1000*d.d + 10000*e.d + 100000*f.d AS n
  FROM digits a
  CROSS JOIN digits b
  CROSS JOIN digits c
  CROSS JOIN digits d
  CROSS JOIN digits e
  CROSS JOIN digits f
)
INSERT INTO ecs_parties(party_type, full_name, status)
SELECT
  'PERSON',
  'First' || n || ' ' || 'Last' || n,
  'ACTIVE'
FROM nums
WHERE n < 120000;

-- Seed 120,000 compliance flags
WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
     nums(n) AS ( SELECT a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 10000 * e.d + 100000 * f.d AS n
                    FROM digits a
                   CROSS JOIN digits b
                   CROSS JOIN digits c
                   CROSS JOIN digits d
                   CROSS JOIN digits e
                   CROSS JOIN digits f )
INSERT INTO ecs_compliance_flags(party_id, account_id, severity, category, note, status)
SELECT (n % (SELECT MAX(ep.party_id) FROM ecs_parties ep)) + 1,
       (n % (SELECT MAX(ea.account_id) FROM ecs_accounts ea)) + 1,
       CASE (n % 3) WHEN 0 THEN 'LOW' WHEN 1 THEN 'MEDIUM' ELSE 'HIGH' END,
       CASE (n % 3) WHEN 0 THEN 'KYC' WHEN 1 THEN 'AML' ELSE 'FRAUD' END,
       'Seed flag #' || n,
       CASE WHEN (n % 5)=0 THEN 'RESOLVED' ELSE 'OPEN' END
  FROM nums
 WHERE n < 120000;
 
-- STEP P2 — Bulk insert matching person_details for all parties
 INSERT INTO ecs_person_details(party_id, first_name, last_name, date_of_birth, tax_id)
SELECT
  party_id,
  'First' || party_id,
  'Last'  || party_id,
  date('1970-01-01', printf('+%d days', party_id % 18000)),
  'TAX' || printf('%09d', party_id)
FROM ecs_parties
WHERE party_type='PERSON'
  AND NOT EXISTS (SELECT 1 FROM ecs_person_details pd WHERE pd.party_id = ecs_parties.party_id);

-- STEP P3 — Bulk insert primary EMAIL contact (120,000)
INSERT INTO ecs_party_contacts(party_id, type, value, is_primary)
SELECT
  party_id,
  'EMAIL',
  'user' || party_id || '@bank.local',
  1
FROM ecs_parties
WHERE NOT EXISTS (
  SELECT 1 FROM ecs_party_contacts pc
  WHERE pc.party_id = ecs_parties.party_id AND pc.type='EMAIL'
);

-- STEP P4 — Bulk insert primary PHONE contact (120,000)
INSERT INTO ecs_party_contacts(party_id, type, value, is_primary)
SELECT
  party_id,
  'PHONE',
  '+30' || printf('%010d', 6900000000 + (party_id % 1000000000)),
  1
FROM ecs_parties
WHERE NOT EXISTS (
  SELECT 1 FROM ecs_party_contacts pc
  WHERE pc.party_id = ecs_parties.party_id AND pc.type='PHONE'
);

SELECT
  (SELECT COUNT(*) FROM ecs_parties) AS parties,
  (SELECT COUNT(*) FROM ecs_person_details) AS person_details,
  (SELECT COUNT(*) FROM ecs_party_contacts WHERE type='EMAIL') AS emails,
  (SELECT COUNT(*) FROM ecs_party_contacts WHERE type='PHONE') AS phones;

-- STEP P5 — Bulk insert addresses (120,000)
WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
nums(n) AS (
  SELECT a.d + 10*b.d + 100*c.d + 1000*d.d + 10000*e.d + 100000*f.d AS n
  FROM digits a
  CROSS JOIN digits b
  CROSS JOIN digits c
  CROSS JOIN digits d
  CROSS JOIN digits e
  CROSS JOIN digits f
)
INSERT INTO ecs_addresses(line1, line2, city, region, postal_code, country)
SELECT
  'Street ' || n,
  'Apt ' || (n % 50),
  CASE (n % 5)
    WHEN 0 THEN 'Athens'
    WHEN 1 THEN 'Thessaloniki'
    WHEN 2 THEN 'Patras'
    WHEN 3 THEN 'Heraklion'
    ELSE 'Larissa'
  END,
  'GR',
  printf('%05d', 10000 + (n % 89999)),
  'Greece'
FROM nums
WHERE n < 120000;

INSERT INTO ecs_party_addresses(party_id, address_id, addr_type, is_primary)
SELECT
  p.party_id,
  a.address_id,
  'HOME',
  1
FROM ecs_parties p
JOIN ecs_addresses a ON a.address_id = p.party_id
WHERE NOT EXISTS (
  SELECT 1
  FROM ecs_party_addresses pa
  WHERE pa.party_id = p.party_id AND pa.addr_type = 'HOME'
);