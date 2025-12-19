SELECT *
  FROM ( SELECT ea.status,
                ea.account_type,
                ec.tier, 
                CASE
         WHEN ea.balance <= 10 THEN 'Low Tier' 
         WHEN ea.balance <= 20 THEN 'Midium To Low Tier' 
         WHEN ea.balance <= 30 THEN 'Low Tier' 
         WHEN ea.balance <= 40 THEN 'Low To High Tier' 
         WHEN ea.balance <= 50 THEN 'High Tier' 
         ELSE 'Very High Tier'
       END AS BalanceClassificatons, 
       COUNT (ec.customer_id) AS Customers, 
       COUNT (ea.account_id) AS Accounts
  FROM ecs_customers ec
 INNER JOIN ecs_accounts ea ON ec.customer_id = ea.customer_id
 GROUP BY ea.status,
          ea.account_type,
          ec.tier,
          CASE
            WHEN ea.balance <= 10 THEN 'Low Tier' 
            WHEN ea.balance <= 20 THEN 'Midium To Low Tier' 
            WHEN ea.balance <= 30 THEN 'Low Tier' 
            WHEN ea.balance <= 40 THEN 'Low To High Tier' 
            WHEN ea.balance <= 50 THEN 'High Tier' 
            ELSE 'Very High Tier'
          END );

UPDATE ecs_customers
   SET tier = CASE
                WHEN ea.balance <= 10 THEN 'Low Tier'
                WHEN ea.balance <= 20 THEN 'Medium To Low Tier'
                WHEN ea.balance <= 30 THEN 'Low Tier'
                WHEN ea.balance <= 40 THEN 'Low To High Tier'
                WHEN ea.balance <= 50 THEN 'High Tier'
                ELSE 'Very High Tier'
              END
  FROM ecs_customers ec
 INNER JOIN ecs_accounts ea ON ec.customer_id = ea.customer_id
 WHERE ec.tier IS NULL
   AND (ea.balance <= 10 AND ea.account_type  = 'CHECKING');
 
UPDATE ecs_customers
   SET tier = CASE
                WHEN ea.balance <= 10 THEN 'Low Tier'
                WHEN ea.balance <= 20 THEN 'Medium To Low Tier'
                WHEN ea.balance <= 30 THEN 'Low Tier'
                WHEN ea.balance <= 40 THEN 'Low To High Tier'
                WHEN ea.balance <= 50 THEN 'High Tier'
                ELSE 'Very High Tier'
              END
  FROM ecs_customers ec
 INNER JOIN ecs_accounts ea ON ec.customer_id = ea.customer_id
 WHERE ec.tier IS NULL
   AND (ea.balance <= 10 AND ea.account_type  = 'SAVINGS');