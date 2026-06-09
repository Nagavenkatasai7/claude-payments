import { describe, it, expect } from 'vitest';
import { createPartnerWhatsappIndex } from '@/lib/partner-whatsapp-index';
import { fakeRedis } from './helpers';

describe('partner-whatsapp-index (phone_number_id → partner)', () => {
  it('sets and resolves a phone_number_id to its partner', async () => {
    const ix = createPartnerWhatsappIndex(fakeRedis());
    await ix.setPnid('111222333', 'acme');
    expect(await ix.partnerForPnid('111222333')).toBe('acme');
  });

  it('returns null for an unmapped phone_number_id (⇒ default partner)', async () => {
    const ix = createPartnerWhatsappIndex(fakeRedis());
    expect(await ix.partnerForPnid('999')).toBeNull();
    expect(await ix.partnerForPnid('')).toBeNull();
  });

  it('clearPnid removes the mapping', async () => {
    const ix = createPartnerWhatsappIndex(fakeRedis());
    await ix.setPnid('111', 'acme');
    await ix.clearPnid('111');
    expect(await ix.partnerForPnid('111')).toBeNull();
  });

  it('isolates partners — distinct numbers resolve to distinct partners', async () => {
    const ix = createPartnerWhatsappIndex(fakeRedis());
    await ix.setPnid('111', 'acme');
    await ix.setPnid('222', 'globex');
    expect(await ix.partnerForPnid('111')).toBe('acme');
    expect(await ix.partnerForPnid('222')).toBe('globex');
  });
});
