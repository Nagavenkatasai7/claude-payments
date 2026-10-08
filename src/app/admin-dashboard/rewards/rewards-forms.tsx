'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CatalogEntry, PartnerRewardTerms } from '@/lib/rewards/types';
import { saveCatalogAction, saveTermsAction, type RewardsAdminResult } from './actions';

// /admin-dashboard/rewards forms (B3 rewards v1). Plain forms: the server actions re-gate and
// validate every field; the client attributes are conveniences only. The result is rendered as
// escaped text (never from the URL).

function Status({ state }: { state: RewardsAdminResult | null }) {
  if (!state) return null;
  return state.ok ? (
    <p role="status" className="text-sm font-semibold text-green-700 dark:text-green-400">Saved. The change is in the audit log.</p>
  ) : (
    <p role="alert" className="text-sm font-semibold text-destructive">{state.error}</p>
  );
}

function NumberField({ id, name, label, defaultValue, step = '1', min, max }: {
  id: string; name: string; label: string; defaultValue: string | number; step?: string; min?: number; max?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} type="number" inputMode="decimal" step={step} min={min} max={max} defaultValue={defaultValue} required />
    </div>
  );
}

export function CatalogForm({ entry }: { entry: CatalogEntry }) {
  const [state, action, pending] = useActionState(saveCatalogAction, null);
  const p = `cat-${entry.kind}`;
  return (
    <form action={action} className="space-y-4" data-testid={`rewards-catalog-${entry.kind}`}>
      <input type="hidden" name="kind" value={entry.kind} />
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" name="available" defaultChecked={entry.available} className="size-4" />
        Partners may offer this reward
      </label>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entry.kind === 'nth_transfer' ? (
          <>
            <NumberField id={`${p}-nthMin`} name="nthMin" label="Lowest N a partner may choose" defaultValue={entry.nthMin} min={2} max={50} />
            <NumberField id={`${p}-nthMax`} name="nthMax" label="Highest N a partner may choose" defaultValue={entry.nthMax} min={2} max={50} />
          </>
        ) : (
          <>
            <input type="hidden" name="nthMin" value={entry.nthMin} />
            <input type="hidden" name="nthMax" value={entry.nthMax} />
            <NumberField id={`${p}-maxDays`} name="maxDays" label="Longest offer (days)" defaultValue={entry.maxDays} min={1} max={31} />
          </>
        )}
        {entry.kind === 'nth_transfer' ? <input type="hidden" name="maxDays" value={entry.maxDays} /> : null}
        <NumberField id={`${p}-maxDiscount`} name="maxDiscountUsd" label="Largest discount per transfer (USD)" defaultValue={entry.maxDiscountUsd.toFixed(2)} step="0.01" min={0} max={100} />
        <NumberField id={`${p}-cap`} name="customerMonthlyCap" label="Rewards per customer per month" defaultValue={entry.customerMonthlyCap} min={1} max={31} />
      </div>
      {entry.kind === 'festival' ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${p}-names`}>Festival names partners may choose (one per line)</Label>
          <textarea id={`${p}-names`} name="festivalNames" rows={4} defaultValue={entry.festivalNames.join('\n')}
            className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm" />
        </div>
      ) : (
        <input type="hidden" name="festivalNames" value="" />
      )}
      <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>
      <Status state={state} />
    </form>
  );
}

export function TermsForm({ partnerId, terms }: { partnerId: string; terms: PartnerRewardTerms }) {
  const [state, action, pending] = useActionState(saveTermsAction, null);
  const p = `terms-${partnerId}`;
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" data-testid={`rewards-terms-${partnerId}`}>
      <input type="hidden" name="partnerId" value={partnerId} />
      <div className="w-32 space-y-1">
        <Label htmlFor={`${p}-fee`} className="text-xs">Platform fee (USD)</Label>
        <Input id={`${p}-fee`} name="platformFeeUsd" type="number" step="0.01" min={0} max={100} defaultValue={terms.platformFeeUsd.toFixed(2)} required />
      </div>
      <div className="w-28 space-y-1">
        <Label htmlFor={`${p}-pct`} className="text-xs">Give-back (%)</Label>
        <Input id={`${p}-pct`} name="giveBackPct" type="number" step="0.01" min={0} max={100} defaultValue={terms.giveBackPct} required />
      </div>
      <div className="w-36 space-y-1">
        <Label htmlFor={`${p}-budget`} className="text-xs">Monthly budget (USD)</Label>
        <Input id={`${p}-budget`} name="monthlyBudgetUsd" type="number" step="0.01" min={0} max={100000} defaultValue={terms.monthlyBudgetUsd.toFixed(2)} required />
      </div>
      <Button type="submit" size="sm" disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>
      <div className="basis-full"><Status state={state} /></div>
    </form>
  );
}
