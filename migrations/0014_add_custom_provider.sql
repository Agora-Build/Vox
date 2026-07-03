INSERT INTO providers (id, name, sku, description, is_active, created_at, updated_at)
SELECT
  substr(md5(random()::text), 1, 12),
  'Custom',
  'convoai',
  'Custom / self-hosted conversational AI agent',
  true,
  now(),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM providers WHERE name = 'Custom'
);
