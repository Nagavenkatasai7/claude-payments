import { describe, it, expect } from 'vitest';
import { LIVE_ACTIVE_MS, LIVE_POLL_MS, liveAutoRefreshAllowed, livePathActive } from '@/lib/partner-live';
import { liveNeeds, liveStamp, liveStampParts } from '@/lib/partner-live-stamp';

// Lost-features A15: /partner lists refresh by themselves. Pure parts: which pages poll, what the
// opaque stamp covers per role, and when an automatic re-render may run (only while the viewer is
// present, so a refresh never keeps an abandoned session alive).
describe('partner live refresh policy', () => {
  it('polls every 30 s', () => {
    expect(LIVE_POLL_MS).toBe(30_000);
  });

  it('only list pages poll (exact match); detail and form pages never do', () => {
    for (const p of ['/partner', '/partner/transfers', '/partner/support', '/partner/reviews', '/partner/refunds']) {
      expect(livePathActive(p), p).toBe(true);
    }
    for (const p of [null, '', '/partner/transfers/abc', '/partner/support/tk_1', '/partner/support/contact', '/partner/customers/new', '/partner/staff', '/partner/transfers/', '/admin-dashboard']) {
      expect(livePathActive(p), String(p)).toBe(false);
    }
  });

  it('an automatic re-render runs only while the viewer was active in the last minute', () => {
    const now = 10_000_000;
    expect(LIVE_ACTIVE_MS).toBe(60_000);
    expect(liveAutoRefreshAllowed(now, now - 1)).toBe(true);
    expect(liveAutoRefreshAllowed(now, now - LIVE_ACTIVE_MS)).toBe(true);
    expect(liveAutoRefreshAllowed(now, now - LIVE_ACTIVE_MS - 1)).toBe(false);
  });
});

describe('liveStampParts', () => {
  const money = 'm1';
  const tickets = 't1';
  it('admin and agent: both parts', () => {
    expect(liveStampParts('admin', { money, tickets })).toEqual({ money, tickets });
    expect(liveStampParts('agent', { money, tickets })).toEqual({ money, tickets });
  });
  it('support: tickets only (no money part ever)', () => {
    expect(liveStampParts('support', { money, tickets })).toEqual({ tickets });
  });
  it('finance: money only (no ticket part)', () => {
    expect(liveStampParts('finance', { money, tickets })).toEqual({ money });
  });
  it('a missing part is left out', () => {
    expect(liveStampParts('support', {})).toEqual({});
  });
  it('which parts a role needs (the route reads nothing else)', () => {
    expect(liveNeeds('admin')).toEqual({ money: true, tickets: true });
    expect(liveNeeds('agent')).toEqual({ money: true, tickets: true });
    expect(liveNeeds('support')).toEqual({ money: false, tickets: true });
    expect(liveNeeds('finance')).toEqual({ money: true, tickets: false });
  });
});

describe('liveStamp', () => {
  it('is 64 hex chars and changes when any part changes', () => {
    const a = liveStamp({ money: 'm1', tickets: 't1' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(liveStamp({ money: 'm1', tickets: 't1' })).toBe(a);
    expect(liveStamp({ money: 'm2', tickets: 't1' })).not.toBe(a);
    expect(liveStamp({ money: 'm1', tickets: 't2' })).not.toBe(a);
    expect(liveStamp({ money: 'm1' })).not.toBe(a);
  });
});
