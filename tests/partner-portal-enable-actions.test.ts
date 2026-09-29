/**
 * M2-14 Task 14.1 (O6): the one-off platform-admin controls that record a
 * partner's approved WhatsApp auth template and switch its portal on. Public
 * POST endpoints: each action refuses on a partner-site host, gates on
 * requirePlatformAdmin BEFORE any read or write, checks the partner exists,
 * and writes through the audited repo writers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { auditEvents, partnerPortalSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';

let currentStaff: { username: string; role: 'admin' | 'agent' | 'support'; partnerId?: string };
class RedirectError extends Error {
  constructor(readonly to: string) {
    super(`NEXT_REDIRECT:${to}`);
  }
}
vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => currentStaff,
  requireStaff: async () => currentStaff,
  // The REAL rule (src/lib/auth.ts): role admin AND no partnerId, else redirect.
  requirePlatformAdmin: async () => {
    if (currentStaff.role !== 'admin' || currentStaff.partnerId !== undefined) throw new RedirectError('/admin-dashboard');
    return currentStaff;
  },
}));
let db: Db;
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
const host = vi.hoisted(() => ({ value: 'smartremit.ai' }));
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  headers: async () => new Headers({ host: host.value }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { recordPortalAuthTemplateAction, enablePartnerPortalAction } from '@/app/admin-dashboard/partners/portal-actions';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const settings = async (pid: string) =>
  (await db.select().from(partnerPortalSettings).where(eq(partnerPortalSettings.partnerId, pid)))[0];
const audits = async (pid: string) =>
  (await db.select().from(auditEvents).where(eq(auditEvents.partnerId, pid))).map((r) => r.action);

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'beta');
  currentStaff = { username: 'root', role: 'admin' };
  host.value = 'smartremit.ai';
});

describe('recordPortalAuthTemplateAction', () => {
  it('a platform admin records the template (validated, audited)', async () => {
    await recordPortalAuthTemplateAction(fd({ id: 'acme', name: 'acme_login_code', lang: 'en_US' }));
    expect(await settings('acme')).toMatchObject({ authTemplateName: 'acme_login_code', authTemplateLang: 'en_US' });
    expect(await audits('acme')).toContain('partner.portal.auth_template');
  });

  it('a partner admin (even of the SAME tenant) is bounced before any write', async () => {
    currentStaff = { username: 'acme-admin', role: 'admin', partnerId: 'acme' };
    await expect(recordPortalAuthTemplateAction(fd({ id: 'acme', name: 'x_code', lang: 'en' }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(await settings('acme')).toBeUndefined();
  });

  it('an invalid name or language, or an unknown partner, is refused with no row', async () => {
    await expect(recordPortalAuthTemplateAction(fd({ id: 'acme', name: 'Bad Name!', lang: 'en' }))).rejects.toThrow(/template name/i);
    await expect(recordPortalAuthTemplateAction(fd({ id: 'acme', name: 'ok_name', lang: 'english' }))).rejects.toThrow(/template name/i);
    await expect(recordPortalAuthTemplateAction(fd({ id: 'nope', name: 'ok_name', lang: 'en' }))).rejects.toThrow(/not found/i);
    expect(await settings('acme')).toBeUndefined();
  });

  it('refuses on a partner-site host (legacy action guard)', async () => {
    host.value = 'acme.smartremit.ai';
    await expect(recordPortalAuthTemplateAction(fd({ id: 'acme', name: 'x_code', lang: 'en' }))).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(await settings('acme')).toBeUndefined();
  });
});

describe('enablePartnerPortalAction', () => {
  it('refused (not ready) without a recorded template and an own number; nothing stamped', async () => {
    await expect(enablePartnerPortalAction(fd({ id: 'acme' }))).rejects.toThrow(/not ready/i);
    expect((await settings('acme'))?.portalEnabledAt ?? null).toBeNull();
  });

  it('template + own number → enabled and audited; only THAT partner', async () => {
    await createIntegrationsRepo(db).saveIntegrations('acme', {
      kyc: {},
      payment: {},
      whatsapp: { phoneNumberId: 'pn_acme', token: 'tok', appSecret: 'sec' },
    } as never);
    await recordPortalAuthTemplateAction(fd({ id: 'acme', name: 'acme_login_code', lang: 'en' }));
    await enablePartnerPortalAction(fd({ id: 'acme' }));
    expect((await settings('acme'))?.portalEnabledAt).toBeInstanceOf(Date);
    expect(await audits('acme')).toContain('partner.portal.enabled');
    expect(await settings('beta')).toBeUndefined();
  });

  it('a partner admin or an agent is bounced before any write', async () => {
    for (const s of [
      { username: 'acme-admin', role: 'admin' as const, partnerId: 'acme' },
      { username: 'agent', role: 'agent' as const },
    ]) {
      currentStaff = s;
      await expect(enablePartnerPortalAction(fd({ id: 'acme' }))).rejects.toThrow(/NEXT_REDIRECT/);
    }
    expect(await settings('acme')).toBeUndefined();
  });

  it('an unknown partner → not found', async () => {
    await expect(enablePartnerPortalAction(fd({ id: 'nope' }))).rejects.toThrow(/not found/i);
  });
});
