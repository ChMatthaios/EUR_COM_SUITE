-- STEP 1 — Bulk insert KYC identity documents (120,000)
-- Create docs (1 per party)
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
INSERT INTO ecs_party_id_documents (party_id, doc_type, doc_number, issued_by, expires_on)
SELECT
  (n + 1) AS party_id,
  CASE (n % 3)
    WHEN 0 THEN 'NATIONAL_ID'
    WHEN 1 THEN 'PASSPORT'
    ELSE 'DRIVER_LICENSE'
  END,
  'DOC' || printf('%010d', n + 1),
  'GR',
  date('now', printf('+%d days', 3650 + (n % 2000)))
FROM nums
WHERE n < 120000
  AND NOT EXISTS (
    SELECT 1
    FROM ecs_party_id_documents d
    WHERE d.party_id = n + 1
  );

-- STEP 2 — Bulk create deposit accounts (150,000) + holders
-- Link PRIMARY holder for each account (150,000 rows)
INSERT INTO ecs_account_holders (account_id, party_id, role)
SELECT
  a.account_id,
  ((a.account_id - 1) % 120000) + 1 AS party_id,
  'PRIMARY'
FROM ecs_accounts a
WHERE NOT EXISTS (
  SELECT 1
  FROM ecs_account_holders h
  WHERE h.account_id = a.account_id
);

-- STEP 3 — Add joint holders (optional, realistic) ~30,000 rows
INSERT INTO ecs_account_holders (account_id, party_id, role)
SELECT
  a.account_id,
  (((a.account_id - 1) * 7) % 120000) + 1 AS party_id,
  'JOINT'
FROM ecs_accounts a
WHERE (a.account_id % 5)=0
  AND NOT EXISTS (
    SELECT 1
    FROM ecs_account_holders h
    WHERE h.account_id = a.account_id AND h.role='JOINT'
  )
  AND (((a.account_id - 1) * 7) % 120000) + 1 <> ((a.account_id - 1) % 120000) + 1;