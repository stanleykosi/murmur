-- Fix agents_tts_provider_check to include mistral
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_tts_provider_check;
ALTER TABLE agents ADD CONSTRAINT agents_tts_provider_check CHECK (tts_provider IN ('cartesia', 'elevenlabs', 'mistral'));