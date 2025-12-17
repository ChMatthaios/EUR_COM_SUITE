BEGIN;

 -- === EDIT ONLY THESE 3 ===
CREATE TEMPORARY TABLE params AS
  SELECT 4242 AS from_acct, 4243 AS to_acct, 12.50 AS amt;
 
CREATE TEMPORARY TABLE tid    AS
  SELECT    'T-'
         || STRFTIME('%Y%m%d%H%M%f', 'now')
         || '-'
         || (SELECT from_acct FROM params)
         || '-'
         || (SELECT to_acct FROM params)    AS transfer_id;
					 
-- Debit leg
INSERT INTO ecs_transactions (account_id, txn_type, amount, description, transfer_id)
SELECT p.from_acct,
       'WITHDRAWAL', 
       p.amt, 
       'Transfer to ' || (SELECT account_number FROM ecs_accounts WHERE account_id = p.to_acct),
       t.transfer_id
  FROM params p, tid t;

UPDATE ecs_accounts
   SET balance = balance - (SELECT amt FROM params)
 WHERE account_id = (SELECT from_acct FROM params);
 
-- Credit leg
INSERT INTO ecs_transactions (account_id, txn_type, amount, description, transfer_id)
SELECT p.to_acct,
       'DEPOSIT', 
       p.amt, 
       'Transfer from ' || (SELECT account_number FROM ecs_accounts WHERE account_id = p.from_acct), 
       t.transfer_id
  FROM params p, tid t;

UPDATE ecs_accounts
   SET balance = balance + (SELECT amt FROM params)
 WHERE account_id = (SELECT to_acct FROM params);

DROP TABLE params;
DROP TABLE tid;