import { describe, it, expect } from 'vitest';
import {
  structuring,
  firstTransfer,
  cluster,
  AML_DEFAULTS,
  type SenderAmlStats,
} from '@/lib/aml-rules';

// Program-Fix 43 (PR A): pure behavioural rules. No I/O. Every rule is
// RISING-EDGE for structuring (fires on the transfer that makes the pattern
// true, not on every later one), so one episode raises one alert.

const T = 1000; // largeAmountUsd
const cfg = { ...AML_DEFAULTS, largeAmountUsd: T };

/** Stats BEFORE the transfer under test (strictly earlier rows only). */
function before(over: Partial<SenderAmlStats> = {}): SenderAmlStats {
  return { bandCount7d: 0, subTSumCents30d: 0, priorCount: 0, ...over };
}

describe('AML_DEFAULTS', () => {
  it('ships the approved thresholds', () => {
    expect(AML_DEFAULTS).toEqual({ band: 0.8, count: 3, aggUsd: 3000, firstUsd: 500, senders: 3 });
  });
});

describe('structuring (R1)', () => {
  it('a run of in-band sends fires once, on the send that reaches the count', () => {
    // sends #1..#4 of $900 each (band = [800, 1000))
    const s1 = structuring(before(), 900, cfg);
    const s2 = structuring(before({ bandCount7d: 1, subTSumCents30d: 90000, priorCount: 1 }), 900, cfg);
    const s3 = structuring(before({ bandCount7d: 2, subTSumCents30d: 180000, priorCount: 2 }), 900, cfg);
    const s4 = structuring(before({ bandCount7d: 3, subTSumCents30d: 270000, priorCount: 3 }), 900, cfg);
    expect([s1, s2, s3, s4].map((h) => h !== null)).toEqual([false, false, true, false]);
    expect(s3).toMatchObject({ rule: 'structuring', window: '7d', count: 3 });
  });

  it('sends at or above the large-amount threshold never count (the existing flag owns them)', () => {
    const h = structuring(before({ bandCount7d: 2, subTSumCents30d: 0, priorCount: 2 }), 1000, cfg);
    expect(h).toBeNull();
  });

  it('band boundaries: exactly band*T is in, just below is out', () => {
    expect(structuring(before({ bandCount7d: 2 }), 800, cfg)).not.toBeNull();
    expect(structuring(before({ bandCount7d: 2 }), 799.99, cfg)).toBeNull();
    expect(structuring(before({ bandCount7d: 2 }), 999.99, cfg)).not.toBeNull();
  });

  it('30-day aggregate of sub-threshold sends fires when it crosses aggUsd', () => {
    const h = structuring(before({ subTSumCents30d: 280000 }), 200, cfg);
    expect(h).toMatchObject({ rule: 'structuring', window: '30d', sumUsd: 3000 });
    expect(structuring(before({ subTSumCents30d: 279900 }), 100, cfg)).toBeNull();
  });

  it('does not re-fire once the aggregate is already over', () => {
    expect(structuring(before({ subTSumCents30d: 300000 }), 200, cfg)).toBeNull();
  });

  it('does not fire on the aggregate when the band count was already met', () => {
    expect(structuring(before({ bandCount7d: 3, subTSumCents30d: 290000 }), 200, cfg)).toBeNull();
  });
});

describe('firstTransfer (R2)', () => {
  it('first-ever send at or above firstUsd fires', () => {
    expect(firstTransfer(before(), 500, null, cfg)).toMatchObject({ rule: 'first_transfer' });
    expect(firstTransfer(before(), 499.99, null, cfg)).toBeNull();
  });

  it('a later send does not fire first_transfer', () => {
    expect(firstTransfer(before({ priorCount: 1 }), 900, null, cfg)).toBeNull();
  });

  it('a send to a destination this sender never used fires new_beneficiary', () => {
    expect(firstTransfer(before({ priorCount: 2 }), 600, true, cfg)).toMatchObject({ rule: 'new_beneficiary' });
    expect(firstTransfer(before({ priorCount: 2 }), 400, true, cfg)).toBeNull();
    expect(firstTransfer(before({ priorCount: 2 }), 600, false, cfg)).toBeNull();
  });

  it('unknown destination novelty (Redis down / seeding) never fires new_beneficiary', () => {
    expect(firstTransfer(before({ priorCount: 2 }), 600, null, cfg)).toBeNull();
  });

  it('first-ever wins over new_beneficiary (one alert, not two)', () => {
    expect(firstTransfer(before(), 600, true, cfg)).toMatchObject({ rule: 'first_transfer' });
  });
});

describe('cluster (R3)', () => {
  it('fires at the distinct-sender threshold', () => {
    expect(cluster(2, cfg)).toBeNull();
    expect(cluster(3, cfg)).toMatchObject({ rule: 'cluster', window: '30d', count: 3 });
    expect(cluster(5, cfg)).toMatchObject({ count: 5 });
  });
});
