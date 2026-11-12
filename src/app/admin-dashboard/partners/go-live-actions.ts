'use server';

// UI redesign M3-21: the platform side of go-live. A partner REQUESTS go-live from its onboarding
// checklist (M3-20, requestGoLive); a SmartRemit platform admin approves it here, and only then may
// the partner hold LIVE API keys (partner-go-live-repo.ts isLiveApproved).
//
// A server action is a public POST endpoint (CLAUDE.md), so this one refuses on a partner-site host
// FIRST, gates on requirePlatformAdmin() BEFORE any read, takes the target ONLY from the `id` field
// (the page's route param; any partnerId / partner field is never read), checks the partner exists,
// validates the reason, and writes the approval and its audit row in ONE transaction. redirect() and
// notFound() are never inside a try (next/dist/docs/01-app/03-api-reference/04-functions/redirect.md).
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { eq } from 'drizzle-orm';
import { getDb, type Tx } from '@/db/client';
import { partners } from '@/db/schema';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { approveGoLive, getGoLive, getGoLiveForUpdate } from '@/db/repos/partner-go-live-repo';
import { loadOnboardingFacts } from '@/db/repos/partner-onboarding-facts';
import { computeOnboardingChecklist, goLivePrerequisitesDone } from '@/lib/partner-onboarding';
import { logWarn } from '@/lib/log';
import { createPartnerStore } from '@/lib/partner-store';
import { requireStaffReason } from '@/lib/send-limits';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { loadLiveReadinessFacts } from '@/db/repos/live-certification-facts';
import { liveReadiness, type LiveReadinessFacts } from '@/lib/live-certification';
import { LIVE_CAPABILITIES, type LiveCapability } from '@/lib/live-controls';
import { isCalendarDate, writeCertification, writeContract, writeFundingMode, writeOptIn, type LiveActor, type LiveWriteResult } from '@/lib/live-controls-write';
import { AML_HOLD_RULES, amlHoldRulesEntry, hasAmlHoldEntry, type AmlHoldRule } from '@/lib/aml-hold';
import { resolveAmlHoldRules } from '@/lib/compliance-config';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { staffMfaEnrolled } from '@/lib/staff-mfa-store';
import { gateStaffStepUp } from '@/lib/partner-step-up-gate';
import { pokeWorker } from '@/lib/outbox';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { CountryCode, Staff } from '@/lib/types';

export type GoLiveApprovalOutcome =
  | 'approved'
  | 'already'
  | 'not_requested'
  | 'reason_required'
  | 'not_active'
  | 'incomplete'
  | 'checklist_unavailable';

/** The pre-transaction checks: request state, partner status, and the M3-20 checklist (steps 1-6). */
async function precheck(id: string, partnerStatus: string): Promise<GoLiveApprovalOutcome | null> {
  const row = await getGoLive(getDb(), id);
  if (!row || !row.requestedAt) return 'not_requested';
  if (row.approvedAt) return 'already';
  // #409 review L1 / #444 review: approval alone never makes a partner live; refuse a non-active one.
  if (partnerStatus !== 'active') return 'not_active';
  try {
    // The same pure rule the partner's own request used (partner-onboarding.ts), re-derived from the
    // stored facts NOW: a step can reopen after the request (e.g. the 7-day WhatsApp test result).
    const facts = await loadOnboardingFacts(getDb(), id);
    return goLivePrerequisitesDone(computeOnboardingChecklist(facts)) ? null : 'incomplete';
  } catch (err) {
    logWarn('admin.go_live.facts', err, { partnerId: id });
    return 'checklist_unavailable'; // fail closed
  }
}

export async function approveGoLiveAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();

  const id = String(formData.get('id') ?? '').trim();
  if (!id) notFound();
  const partner = await createPartnerStore(getDb()).getPartner(id);
  if (!partner) notFound();
  const page = `/admin-dashboard/partners/${encodeURIComponent(id)}`;

  let reason: string | null = null;
  try {
    reason = requireStaffReason(formData.get('reason')); // ≥ 10 characters, bounded
  } catch {
    reason = null;
  }
  if (reason === null) redirect(`${page}?golive=reason_required`);
  const why: string = reason;

  const refused = await precheck(id, partner.status);
  if (refused) redirect(`${page}?golive=${refused}`);

  const outcome = await getDb().transaction(async (tx): Promise<GoLiveApprovalOutcome> => {
    // The row lock serialises two approvers, so exactly one audit row is written.
    const row = await getGoLiveForUpdate(tx, id);
    if (!row || !row.requestedAt) return 'not_requested';
    if (row.approvedAt) return 'already';
    // Re-read the status under a share lock: a suspend between the precheck and here refuses.
    const [p] = await tx.select({ status: partners.status }).from(partners).where(eq(partners.id, id)).limit(1).for('share');
    if (!p || p.status !== 'active') return 'not_active';
    if (!(await approveGoLive(tx, id, staff.username))) return 'not_requested';
    await createAuditRepo(tx).record({
      partnerId: id,
      actor: staff.username,
      actorType: 'staff',
      action: 'partner.go_live.approve',
      subjectId: id,
      // The reason is platform-internal: the tenant audit view drops every meta key not allowlisted
      // for this action (partner-audit-view.ts DETAIL_KEYS).
      meta: { reason: why, actorScope: 'platform' },
    });
    return 'approved';
  });

  revalidatePath(page);
  redirect(`${page}?golive=${outcome}`);
}

// ---------------------------------------------------------------------------------------------
// Fix pack 3 T10 (R15, R13; contract 12): the platform live-money controls under the GoLiveCard.
// certify / revoke the partner for live money, record its signed contract, record or clear a
// per-capability counsel review. Each action is bound by the page to the ROUTE partner id
// (`certifyLiveAction.bind(null, partner.id)`): that id is the only target, a form field never is.
// Order: the site-host guard, requirePlatformAdmin, the target ('default' and an unknown id are
// 'Partner not found.'), the actor's own staff MFA (before the step-up: factorFor would fall back
// to the password), the input, (certify only) the readiness facts, the step-up (always for certify
// and revoke), then ONE transaction with the typed writer (audit, ops alert, partner email), a
// worker poke and a revalidate. Errors are logged by NAME only.
//
// certify: the facts loader reaches the ROOT handle (the staff ledger through getAuthStore, the
// in-process OFAC list), so it runs on getDb() BEFORE the step-up and before any transaction
// (contract 8). Inside the transaction the partner row is locked, re-read, and readiness is
// recomputed on the LOCKED row, so drift since the facts were read (posture, contract, status,
// kycMode, a compliance user taken off the list) refuses. Nothing in the transaction touches
// getDb(), getAuthStore(), Redis or the OFAC source. Four readiness lines are not built until
// PR8/PR9 (pack 4 built provider_block, pack 5 funding), so certify always answers "not ready"
// (pinned in tests/admin-live-actions.test.ts).
// Fix pack 6 T20 (P17): a certification also writes the go-live AML default (holds on, all three
// rules) for every served corridor except IN with no AML entry, in the same transaction.

export type LiveActionResult = { ok: true } | { ok: false; error: string };

const NOT_FOUND = 'Partner not found.';
const NEED_MFA = 'Turn on two-step verification for your own staff account first.';
const FAILED = 'Something went wrong. Nothing was changed. Please try again.';
const FACTS_FAILED = 'The readiness checks could not be read. Nothing was changed.';
const CODE_COPY: Record<Exclude<LiveWriteResult, { ok: true }>['code'], string> = {
  not_found: NOT_FOUND,
  not_ready: 'Not every readiness line passes. Nothing was changed.',
  not_certified: 'This partner is not certified.',
  bad_input: 'Check the fields and try again.',
  kyc_decider_mismatch: 'Check the fields and try again.',
  psp_unavailable: 'Partner-run card payments need Stripe funding switched on and a restricted Stripe key stored first.',
};
const refused = (error: string): LiveActionResult => ({ ok: false, error });
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const pagePath = (id: string) => `/admin-dashboard/partners/${encodeURIComponent(id)}`;

/** After the site-host guard (each action's FIRST statement): the platform-admin gate, the route target and the actor's own MFA. */
async function gateLive(partnerId: unknown): Promise<{ staff: Staff; id: string } | LiveActionResult> {
  const staff = await requirePlatformAdmin();
  const id = typeof partnerId === 'string' ? partnerId.trim() : '';
  if (!id || id === DEFAULT_PARTNER_ID) return refused(NOT_FOUND);
  try {
    if (!(await createPartnerRepo(getDb()).getPartner(id))) return refused(NOT_FOUND);
  } catch (err) {
    logWarn('admin.live.partner_read', errName(err), { partnerId: id });
    return refused(FAILED);
  }
  if (!(await staffMfaEnrolled(staff.username))) return refused(NEED_MFA);
  return { staff, id };
}

function reasonFrom(formData: FormData): string | LiveActionResult {
  try {
    return requireStaffReason(formData.get('reason'));
  } catch (err) {
    return refused(err instanceof Error ? err.message : 'A reason is required.');
  }
}

/** Runs the write in ONE transaction; on ok pokes the worker and revalidates the page. */
async function commit(id: string, scope: string, write: (tx: Tx) => Promise<LiveWriteResult>): Promise<LiveActionResult> {
  let r: LiveWriteResult;
  try {
    r = await getDb().transaction(write);
  } catch (err) {
    logWarn(scope, errName(err), { partnerId: id });
    return refused(FAILED);
  }
  if (!r.ok) return refused(CODE_COPY[r.code]);
  pokeWorker();
  revalidatePath(pagePath(id));
  return { ok: true };
}

export async function certifyLiveAction(partnerId: string, formData: FormData): Promise<LiveActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const g = await gateLive(partnerId);
  if ('ok' in g) return g;
  const { staff, id } = g;
  const reason = reasonFrom(formData);
  if (typeof reason !== 'string') return reason;

  // On the ROOT handle, before the step-up and before any transaction (contract 8).
  let facts: LiveReadinessFacts;
  try {
    facts = await loadLiveReadinessFacts(getDb(), id, new Date());
  } catch (err) {
    logWarn('admin.live.certify.facts', errName(err), { partnerId: id });
    return refused(FACTS_FAILED);
  }

  const stepUp = await gateStaffStepUp(staff, formData, 'live.certify', { always: true });
  if (stepUp) return stepUp;

  return commit(id, 'admin.live.certify', async (tx) => {
    const locked = await tx.select({ id: partners.id }).from(partners).where(eq(partners.id, id)).limit(1).for('no key update');
    if (!locked[0]) return { ok: false, code: 'not_found' };
    const partner = await createPartnerRepo(tx).getPartner(id);
    if (!partner) return { ok: false, code: 'not_found' };
    const readiness = liveReadiness(partner, facts); // on the LOCKED row
    const actor = { username: staff.username, scope: 'platform' as const };
    const r = await writeCertification(tx, id, actor, { kind: 'certify', readiness }, reason);
    if (!r.ok) return r; // not_ready writes nothing (writeCertification refuses before any write)
    await writeGoLiveAmlDefaults(tx, id, partner.countries ?? [], actor);
    return r;
  });
}

/**
 * Fix pack 6 T20 (P17, P21, owner Q-R47.3): the go-live AML default, on the certify transaction's
 * handle and only after the certification was written. Every served corridor except IN that has
 * NO AML entry (hasAmlHoldEntry: neither amlHolds nor amlHoldRules stored) gets holds ON with all
 * three rules, other keys kept; explicit entries (an empty partner list included) are never
 * touched. One aml.hold_rules_set row per defaulted corridor (from/to are RESOLVED lists). A throw
 * rolls the certification back (FAILED copy). Module-local and unexported: not a server action.
 */
async function writeGoLiveAmlDefaults(tx: Tx, id: string, countries: readonly CountryCode[], actor: LiveActor): Promise<void> {
  const defaulted: { country: CountryCode; from: AmlHoldRule[] }[] = [];
  const { found } = await createPartnerRepo(tx).updateCorridorCompliance(id, (prev) => {
    const next = { ...prev };
    for (const c of countries) {
      if (c === 'IN' || hasAmlHoldEntry(prev[c]) || defaulted.some((d) => d.country === c)) continue;
      next[c] = amlHoldRulesEntry(prev[c], AML_HOLD_RULES);
      defaulted.push({ country: c, from: [...resolveAmlHoldRules(prev[c]?.amlHolds === true, prev[c]?.amlHoldRules)] });
    }
    return defaulted.length > 0 ? next : prev;
  });
  if (!found) throw new Error('partner row vanished under the certify lock');
  const audit = createAuditRepo(tx);
  for (const d of defaulted) {
    await audit.record({
      partnerId: id,
      actor: actor.username,
      actorType: 'staff',
      action: 'aml.hold_rules_set',
      subjectId: id,
      meta: { country: d.country, from: d.from, to: [...AML_HOLD_RULES], actorScope: 'platform', reason: 'go_live_default' },
    });
  }
}

export async function revokeLiveAction(partnerId: string, formData: FormData): Promise<LiveActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const g = await gateLive(partnerId);
  if ('ok' in g) return g;
  const { staff, id } = g;
  const reason = reasonFrom(formData);
  if (typeof reason !== 'string') return reason;

  const stepUp = await gateStaffStepUp(staff, formData, 'live.revoke', { always: true });
  if (stepUp) return stepUp;

  return commit(id, 'admin.live.revoke', (tx) => writeCertification(tx, id, { username: staff.username, scope: 'platform' }, { kind: 'revoke' }, reason));
}

export async function recordContractAction(partnerId: string, formData: FormData): Promise<LiveActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const g = await gateLive(partnerId);
  if ('ok' in g) return g;
  const { staff, id } = g;
  const rawRef = formData.get('ref');
  const ref = typeof rawRef === 'string' ? rawRef.trim() : '';
  const signedOn = formData.get('signedOn');
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (ref.length < 1 || ref.length > 200) return refused('Enter the contract reference (up to 200 characters).');
  if (!isCalendarDate(signedOn) || signedOn > todayUtc) return refused('Enter the date the contract was signed (not after today, UTC).');

  const stepUp = await gateStaffStepUp(staff, formData, 'live.contract');
  if (stepUp) return stepUp;

  return commit(id, 'admin.live.contract', (tx) => writeContract(tx, id, { username: staff.username, scope: 'platform' }, { ref, signedOn }));
}

// Fix pack 5 T17 (P17): how the partner collects its senders' money. Platform only, and a step-up
// on EVERY save (the reserved target 'funding.save', always: true). The writer refuses partner_psp
// unless Stripe funding is on and a restricted key is stored (psp_unavailable).
export async function setFundingModeAction(partnerId: string, formData: FormData): Promise<LiveActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const g = await gateLive(partnerId);
  if ('ok' in g) return g;
  const { staff, id } = g;
  const mode = formData.get('mode');
  if (mode !== 'partner_collected' && mode !== 'partner_psp') return refused('Choose a funding mode.');

  const stepUp = await gateStaffStepUp(staff, formData, 'funding.save', { always: true });
  if (stepUp) return stepUp;

  return commit(id, 'admin.live.funding_mode', (tx) => writeFundingMode(tx, id, { username: staff.username, scope: 'platform' }, { mode }));
}

export async function recordCounselAction(partnerId: string, formData: FormData): Promise<LiveActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const g = await gateLive(partnerId);
  if ('ok' in g) return g;
  const { staff, id } = g;
  const cap = formData.get('capability');
  if (typeof cap !== 'string' || !(LIVE_CAPABILITIES as readonly string[]).includes(cap)) return refused('Choose a listed feature.');
  const clear = formData.get('clear') === '1';
  const rawRef = formData.get('counselRef');
  const ref = typeof rawRef === 'string' ? rawRef.trim() : '';
  if (!clear && (ref.length < 1 || ref.length > 200)) return refused('Enter the counsel review reference (up to 200 characters).');

  const stepUp = await gateStaffStepUp(staff, formData, 'optin.counsel');
  if (stepUp) return stepUp;

  return commit(id, 'admin.live.counsel', (tx) =>
    writeOptIn(tx, id, { username: staff.username, scope: 'platform' }, cap as LiveCapability, { kind: 'counsel', counselRef: clear ? null : ref }),
  );
}
