export const dynamic = 'force-dynamic';

import { requirePlatformAdmin } from '@/lib/auth';
import { getDb } from '@/db/client';
import { getPartnerStore } from '@/lib/partner-store';
import { createRewardRepo } from '@/db/repos/reward-repo';
import { computeStatement, statementMonth } from '@/lib/rewards/statement';
import { DEFAULT_TERMS } from '@/lib/rewards/settings';
import { FUNDED_REWARD_KINDS } from '@/lib/rewards/types';
import { demoModeLabel, demoModeSummary } from '@/lib/demo-mode';
import { Sidebar } from '../sidebar';
import { CatalogForm, TermsForm } from './rewards-forms';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

// /admin-dashboard/rewards (B3 rewards v1). Platform ADMIN only. Three parts:
//  1. the reward catalog: which SmartRemit-funded rewards partners may offer, and the limits they
//     choose inside (every Nth transfer free: the N range; festival offer: the longest offer and the
//     festival names); the largest discount and the per-customer monthly cap for each;
//  2. each partner's money terms: platform fee per delivered transfer, give-back percentage and
//     monthly give-back budget ($0 by default: no SmartRemit-funded reward until it is set);
//  3. the monthly statement per partner: fee owed, rewards given, give-back credit, net
//     (statement only in v1: no invoice, no payment).
// Customers see rewards only while the rewards.enabled switch is on (/admin-dashboard/switches),
// and during the beta only on demo-mode phones. This page is a view and two forms; the actions
// validate every field again.

const LABEL: Record<(typeof FUNDED_REWARD_KINDS)[number], { title: string; description: string }> = {
  nth_transfer: { title: 'Every Nth transfer in a month free', description: 'The customer’s Nth delivered transfer in an Eastern-time month has no fee, up to the largest discount.' },
  festival: { title: 'Festival offer', description: 'No fee on transfers of at least the partner’s minimum amount between two dates, up to the largest discount.' },
};

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default async function RewardsAdminPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  await requirePlatformAdmin();
  const params = await searchParams;
  const month = statementMonth(params.month);
  const repo = createRewardRepo(getDb());
  const [catalog, termsByPartner, partners, facts] = await Promise.all([
    repo.getCatalog(),
    repo.listTerms(),
    getPartnerStore().listPartners(),
    repo.statementFacts(month),
  ]);
  const factsByPartner = new Map(facts.map((f) => [f.partnerId, f]));
  const termsOf = (id: string) => termsByPartner.get(id) ?? DEFAULT_TERMS;
  const statements = partners.map((p) =>
    computeStatement(month, factsByPartner.get(p.id) ?? { partnerId: p.id, deliveredCount: 0, feeOwedUsd: 0, rewards: [] }, termsOf(p.id)),
  );
  const nameOf = new Map(partners.map((p) => [p.id, p.name]));

  return (
    <>
      <Sidebar active="rewards" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Rewards</div>
            <div className="sh-page-sub">
              What partners may offer, each partner&apos;s platform fee, give-back and budget, and the monthly statement.
              A reward lowers only the fee, never below $0. First transfer free works as today.
            </div>
          </div>
        </div>

        <p className="mb-4 text-sm text-muted-foreground" data-testid="demo-mode">
          {demoModeLabel(demoModeSummary())}. Customers see rewards only while the &ldquo;Customer rewards&rdquo; switch is on (Switches), and during the beta only on demo-mode phones.
        </p>

        <h2 className="mb-3 text-lg font-semibold">Reward catalog</h2>
        {FUNDED_REWARD_KINDS.map((kind) => (
          <Card key={kind} className="mb-5">
            <CardHeader>
              <CardTitle>{LABEL[kind].title}</CardTitle>
              <CardDescription>{LABEL[kind].description}</CardDescription>
            </CardHeader>
            <CardContent>
              <CatalogForm entry={catalog[kind]} />
            </CardContent>
          </Card>
        ))}

        <h2 className="mb-3 mt-8 text-lg font-semibold">Partner terms</h2>
        <Card className="mb-5">
          <CardContent className="space-y-5 pt-6">
            {partners.length === 0 ? <p className="text-sm text-muted-foreground">No partners yet.</p> : null}
            {partners.map((p) => (
              <div key={p.id} className="space-y-2 border-b pb-4 last:border-b-0 last:pb-0">
                <p className="text-sm font-semibold">
                  {p.name} <span className="font-normal text-muted-foreground">({p.id})</span>
                </p>
                <TermsForm partnerId={p.id} terms={termsOf(p.id)} />
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="mb-3 mt-8 flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg font-semibold">Monthly statement · {month}</h2>
          <form method="get" className="flex items-end gap-2">
            <Input name="month" type="month" defaultValue={month} aria-label="Statement month" className="w-44" />
            <Button type="submit" size="sm" variant="outline">Show</Button>
          </form>
        </div>
        <Card className="mb-5">
          <CardContent className="pt-6">
            <Table data-testid="rewards-statement">
              <TableHeader>
                <TableRow>
                  <TableHead>Partner</TableHead>
                  <TableHead className="text-right">Delivered</TableHead>
                  <TableHead className="text-right">Fee owed</TableHead>
                  <TableHead className="text-right">Rewards given</TableHead>
                  <TableHead className="text-right">Withheld (flagged)</TableHead>
                  <TableHead className="text-right">First free</TableHead>
                  <TableHead className="text-right">Give-back credit</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statements.map((s) => (
                  <TableRow key={s.partnerId}>
                    <TableCell>{nameOf.get(s.partnerId) ?? s.partnerId}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.deliveredCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(s.feeOwedUsd)}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.rewardsGiven.count} · {usd(s.rewardsGiven.usd)}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.withheld.count} · {usd(s.withheld.usd)}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.firstTransferFree.count} · {usd(s.firstTransferFree.usd)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {usd(s.giveBackCreditUsd)}
                      {s.giveBackEarnedUsd > s.giveBackCreditUsd ? (
                        <span className="block text-xs text-muted-foreground">earned {usd(s.giveBackEarnedUsd)}, budget {usd(s.budgetUsd)}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{usd(s.netUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-3 text-xs text-muted-foreground">
              Statement only: no invoice or payment in v1. Net = fee owed − give-back credit (negative: SmartRemit owes the partner).
              Refunded transfers are left out of rewards; a flagged transfer&apos;s reward earns no give-back.
            </p>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
