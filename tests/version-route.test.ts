import { describe, it, expect, afterEach, vi } from 'vitest';
import * as route from '@/app/api/version/route';

// The route is a thin shell over versionBody(): anonymous, uncached, and it
// reads the SHA at REQUEST time so every deployment answers with its own build.

const FULL = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/version', () => {
  it('returns { sha } with the first 7 chars of VERCEL_GIT_COMMIT_SHA', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', FULL);
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sha: 'a1b2c3d' });
  });

  it("returns { sha: 'unknown' } when the env var is absent", async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sha: 'unknown' });
  });

  it('is never cached (Cache-Control: no-store)', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', FULL);
    const res = await route.GET();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is forced dynamic so a build-time prerender can never pin an old SHA', () => {
    expect(route.dynamic).toBe('force-dynamic');
  });

  it('exports GET only (no mutating methods on an anonymous endpoint)', () => {
    const methods = ['POST', 'PUT', 'PATCH', 'DELETE'].filter((m) => m in route);
    expect(methods).toEqual([]);
  });
});
