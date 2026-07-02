ALTER TABLE "providers" ADD COLUMN "platform_id" text;

UPDATE providers SET platform_id = 'agora'      WHERE name = 'Agora ConvoAI Engine' AND platform_id IS NULL;
UPDATE providers SET platform_id = 'livekit'    WHERE name = 'LiveKit Agents'       AND platform_id IS NULL;
UPDATE providers SET platform_id = 'elevenlabs' WHERE name = 'ElevenLabs Agents'    AND platform_id IS NULL;
