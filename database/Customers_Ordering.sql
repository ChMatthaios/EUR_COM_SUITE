CREATE TEMPORARY TABLE tmp AS
SELECT *
  FROM ( SELECT ec.customer_id,
                ec.first_name,
                ec.last_name,
                ec.email,
                ec.created_at,
                CASE
                  WHEN ea.balance <= 10 THEN 'Low Tier'
                  WHEN ea.balance <= 20 THEN 'Medium To Low Tier'
                  WHEN ea.balance <= 30 THEN 'Low Tier'
                  WHEN ea.balance <= 40 THEN 'Low To High Tier'
                  WHEN ea.balance <= 50 THEN 'High Tier'
                  ELSE 'Very High Tier'
                END AS tier,
                ec.tier AS tier_Now
           FROM ecs_customers ec
          INNER JOIN ecs_accounts ea ON ec.customer_id = ea.customer_id );

DELETE FROM ecs_customers where tier is null;

INSERT INTO ecs_customers (customer_id, first_name, last_name, email, created_at, tier) 
SELECT * FROM tmp;

DROP TABLE tmp;

SELECT * FROM ecs_customers ec;