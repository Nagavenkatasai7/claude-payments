import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { renderToStaticMarkup } from 'react-dom/server';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';

// Batch B4: the public /referral-rewards page exists only while an admin has set the rewards
// portal address; it links there (https only, re-checked on read) under the SmartRemit brand.

let db: Db;
vi.mock('@/db/client', async (orig) => ({ ...((await orig()) as object), getDb: () => db }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));

import ReferralRewardsPage from '@/app/referral-rewards/page';
import { createReferralRepo } from '@/db/repos/referral-repo';

beforeEach(async () => {
  db = await freshDb();
});

describe('/referral-rewards', () => {
  it('404 while the address is empty or cleared', async () => {
    await expect(ReferralRewardsPage()).rejects.toThrow('NOT_FOUND');
    await createReferralRepo(db).setPlumPortalUrl(null, 'raj');
    await expect(ReferralRewardsPage()).rejects.toThrow('NOT_FOUND');
  });

  it('links to the rewards portal, SmartRemit-branded', async () => {
    await createReferralRepo(db).setPlumPortalUrl('https://rewards.example.com/smartremit', 'raj');
    const html = renderToStaticMarkup(await ReferralRewardsPage());
    expect(html).toContain('href="https://rewards.example.com/smartremit"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('SmartRemit');
  });

  it('a non-https value in the table (written around the admin form) is never rendered: 404', async () => {
    await db.execute(sql`INSERT INTO referral_program_settings (id, plum_portal_url, updated_by) VALUES ('global', 'javascript:alert(1)', 'x')`);
    await expect(ReferralRewardsPage()).rejects.toThrow('NOT_FOUND');
  });
});
