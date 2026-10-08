import { easternMonth } from '../dates';
import type { StatementFacts } from '@/db/repos/reward-repo';
import type { PartnerRewardTerms } from './types';

// B3 rewards v1: the monthly statement per partner (statement only in v1: no
// invoice and no payment). Pure maths over the repo's facts, all in cents:
//   fee owed      = Σ platform fee rows of transfers delivered that ET month
//   rewards given = SmartRemit-program rewards (every Nth, festival) on those
//                   transfers, withheld ones included (the partner paid them)
//   give-back     = Σ the 40% (placeholder) credit of the rewards NOT withheld,
//                   never more than the partner's monthly budget
//   net           = fee owed − give-back credit (negative: SmartRemit owes)
// First transfer free is shown on its own line: today's pricing rule, funded
// by the partner, never credited. Refunded transfers are left out by the repo.

export interface Statement {
  month: string;
  partnerId: string;
  deliveredCount: number;
  feeOwedUsd: number;
  firstTransferFree: { count: number; usd: number };
  rewardsGiven: { count: number; usd: number };
  withheld: { count: number; usd: number };
  giveBackEarnedUsd: number;
  budgetUsd: number;
  giveBackCreditUsd: number;
  netUsd: number;
}

const cents = (usd: number) => Math.round(usd * 100);
const usd = (c: number) => c / 100;

export function computeStatement(month: string, f: StatementFacts, terms: PartnerRewardTerms): Statement {
  let firstC = 0, firstN = 0, givenC = 0, givenN = 0, withheldC = 0, withheldN = 0, earnedC = 0;
  for (const r of f.rewards) {
    if (r.kind === 'first_transfer') {
      firstC += cents(r.discountUsd);
      firstN += r.count;
      continue;
    }
    givenC += cents(r.discountUsd);
    givenN += r.count;
    if (r.withheld) {
      withheldC += cents(r.discountUsd);
      withheldN += r.count;
    } else {
      earnedC += cents(r.giveBackUsd);
    }
  }
  const feeC = cents(f.feeOwedUsd);
  const budgetC = Math.max(0, cents(terms.monthlyBudgetUsd));
  const creditC = Math.min(earnedC, budgetC);
  return {
    month,
    partnerId: f.partnerId,
    deliveredCount: f.deliveredCount,
    feeOwedUsd: usd(feeC),
    firstTransferFree: { count: firstN, usd: usd(firstC) },
    rewardsGiven: { count: givenN, usd: usd(givenC) },
    withheld: { count: withheldN, usd: usd(withheldC) },
    giveBackEarnedUsd: usd(earnedC),
    budgetUsd: usd(budgetC),
    giveBackCreditUsd: usd(creditC),
    netUsd: usd(feeC - creditC),
  };
}

/** The month a statement page shows: a valid 'YYYY-MM' from the query, else the current ET month. */
export function statementMonth(raw: unknown, now: Date = new Date()): string {
  if (typeof raw === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return raw;
  return easternMonth(now.getTime());
}
