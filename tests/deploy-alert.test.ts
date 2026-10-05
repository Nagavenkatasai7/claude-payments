import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { buildDeployAlert } from '@/lib/deploy-alert';
import type { Db } from '@/db/client';

// Release safety Batch 2 part B: the ops alert a workflow raises about a
// release. Fixed kinds, fixed text, SHAs only; Bearer CRON_SECRET fail-closed;
// one outbox row per dedupe key.

const SECRET = 'deploy-alert-test-secret';
const FROM = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const TO = '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567';

const box = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => box.db };
});

import * as route from '@/app/api/ops/deploy-alert/route';

function req(body: unknown, authorization: string | null = `Bearer ${SECRET}`): Request {
  return new Request('https://smartremit.ai/api/ops/deploy-alert', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function alerts(db: Db): Promise<Array<{ m: string; k: string }>> {
  const r = (await db.execute(sql`SELECT payload->>'message' AS m, dedupe_key AS k FROM outbox WHERE kind = 'ops.alert' ORDER BY id`)) as unknown as {
    rows: Array<{ m: string; k: string }>;
  };
  return r.rows;
}

describe('buildDeployAlert', () => {
  it('release_check_failed names the short SHA and keys on SHA + deployment', () => {
    const a = buildDeployAlert({ kind: 'release_check_failed', sha: FROM, deploymentId: 'dpl_AbC123xyz', runId: '123' })!;
    expect(a.message).toContain('a1b2c3d');
    expect(a.message).toContain('stays held');
    expect(a.message).toContain('GitHub run 123');
    expect(a.dedupeKey).toBe('deploy:release_check_failed:a1b2c3d:dpl_AbC123xyz');
  });

  it('rollback_done names both builds and the promote rule', () => {
    const a = buildDeployAlert({ kind: 'rollback_done', fromSha: FROM, toSha: TO })!;
    expect(a.message).toContain('a1b2c3d');
    expect(a.message).toContain('0f1e2d3');
    expect(a.message).toContain('until a person promotes one');
    expect(a.dedupeKey).toBe('deploy:rollback_done:a1b2c3d');
  });

  it('rollback_failed points at the manual steps', () => {
    expect(buildDeployAlert({ kind: 'rollback_failed', fromSha: FROM })!.message).toContain('docs/ROLLBACK.md');
  });

  it.each([
    ['no body', null],
    ['an unknown kind', { kind: 'free_text', sha: FROM }],
    ['a non-hex SHA', { kind: 'release_check_failed', sha: '<b>hi</b>' }],
    ['rollback_done without a target', { kind: 'rollback_done', fromSha: FROM }],
    ['an injected run id', { kind: 'rollback_failed', fromSha: FROM, runId: '1 call me' }],
  ])('refuses %s (or drops the bad field)', (_name, body) => {
    const a = buildDeployAlert(body);
    if (a) expect(a.message).not.toContain('call me');
    else expect(a).toBeNull();
  });

  it('never copies a bad deployment id into the key', () => {
    expect(buildDeployAlert({ kind: 'release_check_failed', sha: FROM, deploymentId: 'x:y' })!.dedupeKey).toBe(
      'deploy:release_check_failed:a1b2c3d:-',
    );
  });
});

describe('POST /api/ops/deploy-alert', { retry: 0 }, () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    box.db = db;
    vi.stubEnv('CRON_SECRET', SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    box.db = null;
  });

  it('401 without the bearer, and 401 when CRON_SECRET is unset (fail-closed); nothing queued', async () => {
    expect((await route.POST(req({ kind: 'rollback_failed', fromSha: FROM }, null))).status).toBe(401);
    expect((await route.POST(req({ kind: 'rollback_failed', fromSha: FROM }, 'Bearer nope'))).status).toBe(401);
    vi.stubEnv('CRON_SECRET', '');
    expect((await route.POST(req({ kind: 'rollback_failed', fromSha: FROM }))).status).toBe(401);
    expect(await alerts(db)).toEqual([]);
  });

  it('400 on an invalid body or bad JSON; nothing queued', async () => {
    expect((await route.POST(req({ kind: 'nope' }))).status).toBe(400);
    expect((await route.POST(req('{not json'))).status).toBe(400);
    expect(await alerts(db)).toEqual([]);
  });

  it('queues one ops alert; a re-run with the same SHA queues nothing new', async () => {
    const first = await route.POST(req({ kind: 'rollback_done', fromSha: FROM, toSha: TO }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ queued: true });
    const again = await route.POST(req({ kind: 'rollback_done', fromSha: FROM, toSha: TO }));
    expect(await again.json()).toEqual({ queued: false });
    const rows = await alerts(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].k).toBe('deploy:rollback_done:a1b2c3d');
  });
});
