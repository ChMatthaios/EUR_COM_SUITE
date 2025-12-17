-- v_customer_summary (## Customer summary view (total balance + #accounts) ##)
CREATE VIEW IF NOT EXISTS v_customer_summary
AS
SELECT c.customer_id,
       c.first_name,
       c.last_name,
       c.email,
       COUNT(a.account_id) AS accounts_count,
       ROUND(COALESCE(SUM(a.balance),0), 2) AS total_balance
  FROM ecs_customers c
  LEFT JOIN ecs_accounts a ON a.customer_id = c.customer_id
 GROUP BY c.customer_id;
 
SELECT * FROM v_customer_summary;

-- v_account_statement (## Account statement view (ledger-style) ##)
CREATE VIEW IF NOT EXISTS v_account_statement
AS
  SELECT a.account_id,
         a.account_number,
         t.transaction_id,
         t.txn_ts,
         t.txn_type,
         t.amount,
         t.transfer_id,
         t.description
    FROM ecs_accounts a
    JOIN ecs_transactions t ON t.account_id = a.account_id;

SELECT * FROM v_account_statement;

-- v_transfer_intergrity (## Transfer integrity (must be 2 legs, net 0, same amount) ##)
CREATE VIEW IF NOT EXISTS v_transfer_intergrity
AS
  WITH x AS ( SELECT transfer_id, COUNT(*) AS legs, ROUND(SUM(CASE txn_type WHEN 'DEPOSIT' THEN amount ELSE -amount END), 6) AS net, MIN(amount) AS min_amt, MAX(amount) AS max_amt
                FROM ecs_transactions
               WHERE transfer_id IS NOT NULL
               GROUP BY transfer_id )
  SELECT *, CASE WHEN legs <> 2 OR net <> 0 OR min_amt <> max_amt THEN 'BAD' ELSE 'GOOD' END as IntCheck
    FROM x
   ORDER BY transfer_id DESC
   LIMIT 100;

SELECT * FROM v_transfer_intergrity;

-- v_mismatch_finder (## Accounts vs ledger reconciliation (sample + full) ##)
CREATE VIEW IF NOT EXISTS v_mismatch_finder
AS
  SELECT a.account_id,
         a.balance AS stored_balance,
         ROUND(( SELECT COALESCE(SUM(CASE txn_type WHEN 'DEPOSIT' THEN amount ELSE -amount END), 0.0)
                   FROM ecs_transactions t
                  WHERE t.account_id = a.account_id ), 2) AS computed_balance,
         CASE
           WHEN ROUND(a.balance, 2) <> ROUND(( SELECT COALESCE(SUM(CASE txn_type WHEN 'DEPOSIT' THEN amount ELSE -amount END), 0.0)
                                                 FROM ecs_transactions t
                                                WHERE t.account_id = a.account_id ), 2) THEN
             'ERROR'
           ELSE
             'GOOD'
         END as MisMatch
    FROM ecs_accounts a;

SELECT * FROM v_mismatch_finder LIMIT 50;