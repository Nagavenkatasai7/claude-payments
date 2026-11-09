import { afterEach } from 'vitest';

// Give the event loop one turn after every test. PGlite runs in-process, so a
// PGlite-heavy file can run all its tests on microtasks alone: the worker then
// never reads Vitest's RPC replies, and a file past 60 s fails its shard with
// "Timeout calling onTaskUpdate" though every test passed (tools.test.ts: 44 s
// with no turn). The real setImmediate is kept here, before any test fakes
// timers. Pinned by tests/event-loop-yield.test.ts.
const realSetImmediate = globalThis.setImmediate;
afterEach(() => new Promise<void>((resolve) => realSetImmediate(resolve)));

process.env.ANTHROPIC_API_KEY ||= 'test-key';
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
