/**
 * M2-6: the read side of partner_portal_settings (migration 0027). The pay step
 * reads the partner's approved auth template by the transfer's partnerId only.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb } from './helpers-db';
import { partners, partnerPortalSettings } from '@/db/schema';
import type { Db } from '@/db/client';
import { getPortalSettings, portalAuthTemplate } from '@/db/repos/portal-settings-repo';

describe('getPortalSettings', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await db.insert(partners).values([{ id: 'pa', name: 'A' }, { id: 'pb', name: 'B' }]);
  });

  it("returns only the named partner's row (A's template is never returned for B)", async () => {
    const enabled = new Date('2026-09-01T00:00:00Z');
    await db.insert(partnerPortalSettings).values({
      partnerId: 'pa', authTemplateName: 'login_code', authTemplateLang: 'en_US', portalEnabledAt: enabled,
    });
    expect(await getPortalSettings(db, 'pa')).toEqual({
      authTemplateName: 'login_code', authTemplateLang: 'en_US', portalEnabledAt: enabled,
    });
    expect(await getPortalSettings(db, 'pb')).toEqual({
      authTemplateName: null, authTemplateLang: null, portalEnabledAt: null,
    });
  });

  it('no row at all → all nulls', async () => {
    expect(await getPortalSettings(db, 'nope')).toEqual({
      authTemplateName: null, authTemplateLang: null, portalEnabledAt: null,
    });
  });
});

describe('portalAuthTemplate', () => {
  it('returns the template only when BOTH name and language are recorded', () => {
    expect(portalAuthTemplate({ authTemplateName: 'login_code', authTemplateLang: 'en', portalEnabledAt: null }))
      .toEqual({ name: 'login_code', lang: 'en' });
    expect(portalAuthTemplate({ authTemplateName: 'login_code', authTemplateLang: null, portalEnabledAt: null }))
      .toBeUndefined();
    expect(portalAuthTemplate({ authTemplateName: null, authTemplateLang: 'en', portalEnabledAt: null }))
      .toBeUndefined();
    expect(portalAuthTemplate({ authTemplateName: '', authTemplateLang: 'en', portalEnabledAt: null }))
      .toBeUndefined();
  });
});
