import type { DraftStore } from '@/lib/draft-store';
import type { RiskSignal, RiskSignalConfig } from '@/lib/risk-signals';
import type { Draft } from '@/lib/types';

// Fix pack 6 (P24, T25): risk-signal test helpers.

/**
 * The STORED shape of `partners.corridor_compliance[CC].riskSignals` (what the
 * platform writer saves, P22): on, $500, 72 h, nothing held, then `o`.
 */
export function riskConfigFor(
  o: Partial<RiskSignalConfig> = {},
): { enabled: boolean; amountUsd: number; newAccountHours: number; hold: RiskSignal[] } {
  const { hold, ...rest } = o;
  return { enabled: true, amountUsd: 500, newAccountHours: 72, ...rest, hold: hold ? [...hold] : [] };
}

/**
 * Give a REAL draft the signals the pay page would show (T27): reads it with
 * getDraft, writes it back with `riskSignals` through restoreDraft, returns it.
 * Throws when the draft does not exist (a fixture bug, never a silent no-op).
 */
export async function draftWithRiskSignals(
  draftStore: DraftStore,
  o: { draftId: string; riskSignals: RiskSignal[] },
): Promise<Draft> {
  const draft = await draftStore.getDraft(o.draftId);
  if (!draft) throw new Error(`draftWithRiskSignals: no draft ${o.draftId}`);
  const next = { ...draft, riskSignals: [...o.riskSignals] } as Draft;
  await draftStore.restoreDraft(next, o.draftId);
  return next;
}
