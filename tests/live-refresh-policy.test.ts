import { describe, it, expect } from 'vitest';
import { LIVE_IDLE_PAUSE_MS, LIVE_REFRESH_EVERY_TICKS, liveTickAction } from '@/lib/live-refresh-policy';

// partner-demo R4 (Neon compute): every dashboard poll is two Neon aggregates
// and every 60 s refresh is a full server render, so an open tab kept the
// free-tier compute awake. The policy: skip ticks while the tab is hidden
// (Page Visibility API), pause after 15 min without input, otherwise the
// existing cadence (stamp poll each tick, full refresh every 12th tick).

const now = 1_000_000_000;
const active = { hidden: false, now, lastInputAt: now - 1_000 };

describe('liveTickAction', () => {
  it('a hidden tab never polls or refreshes', () => {
    for (const tick of [1, 12, 24]) {
      expect(liveTickAction({ ...active, hidden: true, tick })).toBe('skip');
    }
  });

  it('pauses after LIVE_IDLE_PAUSE_MS (15 min) without input', () => {
    expect(LIVE_IDLE_PAUSE_MS).toBe(15 * 60_000);
    expect(liveTickAction({ ...active, lastInputAt: now - LIVE_IDLE_PAUSE_MS, tick: 1 })).toBe('pause');
    expect(liveTickAction({ ...active, lastInputAt: now - LIVE_IDLE_PAUSE_MS + 1, tick: 1 })).toBe('poll');
  });

  it('idle wins over the refresh tick; hidden wins over idle (a hidden tab does nothing at all)', () => {
    expect(liveTickAction({ ...active, lastInputAt: 0, tick: LIVE_REFRESH_EVERY_TICKS })).toBe('pause');
    expect(liveTickAction({ ...active, hidden: true, lastInputAt: 0, tick: 1 })).toBe('skip');
  });

  it('active and visible: the existing cadence — full refresh every 12th tick, stamp poll otherwise', () => {
    expect(LIVE_REFRESH_EVERY_TICKS).toBe(12);
    expect(liveTickAction({ ...active, tick: 12 })).toBe('refresh');
    expect(liveTickAction({ ...active, tick: 24 })).toBe('refresh');
    expect(liveTickAction({ ...active, tick: 1 })).toBe('poll');
    expect(liveTickAction({ ...active, tick: 11 })).toBe('poll');
  });
});
