-- Top 20 customers by total balance
SELECT c.customer_id, c.first_name, c.last_name, SUM(a.balance) AS total_balance
  FROM ecs_customers c
  JOIN ecs_accounts a ON a.customer_id = c.customer_id
 GROUP BY c.customer_id
 ORDER BY total_balance DESC
 LIMIT 20;

-- Total deposits/withdrawals volume
SELECT txn_type, COUNT(*) AS txn_count, ROUND(SUM(amount), 2) AS total_amount
  FROM ecs_transactions
 GROUP BY txn_type;

-- “Busiest” accounts by number of transactions
SELECT a.account_id, a.account_number, COUNT(t.transaction_id) AS txn_count
  FROM ecs_accounts a
  JOIN ecs_transactions t ON t.account_id = a.account_id
 GROUP BY a.account_id
 ORDER BY txn_count DESC
 LIMIT 20;

-- Daily transaction volume (last ~30 days of your seeded timestamps)
SELECT date(txn_ts) AS day, COUNT(*) AS txn_count, ROUND(SUM(amount), 2) AS gross_amount
  FROM ecs_transactions
 GROUP BY date(txn_ts)
 ORDER BY day DESC
 LIMIT 30;
 
SELECT COUNT(*) FROM ecs_accounts WHERE account_number IS NULL;
SELECT COUNT(DISTINCT account_number), COUNT(*) FROM ecs_accounts;