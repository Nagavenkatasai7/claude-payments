process.env.OLLAMA_BASE_URL ||= 'https://ollama.test/v1';
process.env.OLLAMA_API_KEY ||= 'test-key';
process.env.OLLAMA_MODEL ||= 'kimi-test';
process.env.WHATSAPP_TOKEN ||= 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID ||= '123456';
process.env.WHATSAPP_VERIFY_TOKEN ||= 'verify-test';
process.env.APP_BASE_URL ||= 'https://smartremit.test';
process.env.KV_REST_API_URL ||= 'https://kv.test';
process.env.KV_REST_API_TOKEN ||= 'kv-token';
process.env.SEED_ADMIN_USERNAME ||= 'admin';
process.env.SEED_ADMIN_PASSWORD ||= 'admin-test-pw';
// Stage 2a: the Postgres repos envelope-encrypt payout destinations / PII via
// the default EnvKeyProvider — give tests a fixed 32-byte master key so any
// store built without an injected provider just works.
process.env.FIELD_ENCRYPTION_KEY ||=
  '0707070707070707070707070707070707070707070707070707070707070707';
// PGlite-backed singletons must never dial a real database in tests.
process.env.DATABASE_URL ||= 'postgres://test-not-used';
