INSERT INTO providers (id, name, sku, description, is_active, created_at, updated_at)
SELECT
  substr(md5(random()::text), 1, 12),
  'ElevenLabs Agents',
  'convoai',
  'ElevenLabs Conversational AI Agents',
  true,
  now(),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM providers WHERE name = 'ElevenLabs Agents'
);