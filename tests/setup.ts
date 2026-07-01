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

// In vitest forks pool (isolate:true) this file is re-evaluated for every
// test file, right after the previous file's module registry is cleared.
// At that point the previous file's PGlite WASM backing stores are unreachable
// (the test's `db` variable and helpers-db's module-level refs are both gone),
// so a gc() here actually frees the memory before the new file allocates more.
// Without this, gc() in helpers-db.ts afterAll fires while the test's `db`
// variable is still live — the WASM memory is reachable and cannot be freed,
// causing 6+ PGlite instances × ~670 MB to accumulate to 4 GB OOM.
(global as typeof globalThis & { gc?: () => void }).gc?.();
