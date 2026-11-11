// live-controls — Fix pack 3 (R15 R27 R13 R26): the parsed shape of
// partners.live_controls (migration 0037).
//
// The column holds one JSON object whose keys are written one at a time by
// updateLiveControlsKey (src/db/repos/partner-repo.ts), the ONE writer. This
// module only READS it: each key is validated on its own and fails closed on
// its own (a malformed key reads as absent, the others survive), and the
// parse never throws. A missing or malformed certification therefore reads as
// "not certified", and a malformed posture as "not signed".
//
// zod only: no runtime import of types.ts or any repo, so pure callers
// (live-gate.ts, tests) can use it without pulling the database in.

import * as z from 'zod';

export const LIVE_CAPABILITIES = ['b2b', 'usdc', 'telegram', 'mcp', 'schedules'] as const;
export type LiveCapability = (typeof LIVE_CAPABILITIES)[number];

/** 'partner' <-> kycMode 'delegated'; 'smartremit_procedures' <-> kycMode 'ours'. */
export type KycDecider = 'partner' | 'smartremit_procedures';

export interface PostureRecord {
  version: 1;
  signedBy: string;
  signedAt: string;
  kycDecider: KycDecider;
  holdDecider: 'partner' | 'smartremit_delegated';
  requireKycBeforeSend: true;
  fourEyesNonSanctions: boolean;
}

export interface CertificationRecord {
  certifiedAt: string;
  certifiedBy: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface ContractRecord {
  ref: string;
  /** YYYY-MM-DD */
  signedOn: string;
  recordedBy: string;
  recordedAt: string;
}

export interface OptInRecord {
  counselRef?: string;
  counselBy?: string;
  counselAt?: string;
  partnerApprovedBy?: string;
  partnerApprovedAt?: string;
}

export interface LiveControls {
  posture?: PostureRecord;
  certification?: CertificationRecord;
  contract?: ContractRecord;
  optIns: Partial<Record<LiveCapability, OptInRecord>>;
  complianceUsers: string[];
  // Reserved for later packs (PR5, PR8): copied as stored, never read, no writer.
  fundingMode?: unknown;
  licence?: unknown;
  retentionYears?: unknown;
}

export const LIVE_CONTROLS_KEYS = ['posture', 'certification', 'contract', 'optIns', 'complianceUsers'] as const;
export type LiveControlsKey = (typeof LIVE_CONTROLS_KEYS)[number];

export const EMPTY_LIVE_CONTROLS: LiveControls = Object.freeze({
  optIns: Object.freeze({}) as LiveControls['optIns'],
  complianceUsers: Object.freeze([]) as unknown as string[],
});

const RESERVED_KEYS = ['fundingMode', 'licence', 'retentionYears'] as const;
const MAX_STRING = 200;
const MAX_COMPLIANCE_USERS = 20;

const text = z.string().min(1).max(MAX_STRING);
const timestamp = z
  .string()
  .max(MAX_STRING)
  .refine((s) => !Number.isNaN(Date.parse(s)));
const dateOnly = z.string().refine((s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
});

const postureSchema = z.object({
  version: z.literal(1),
  signedBy: text,
  signedAt: timestamp,
  kycDecider: z.enum(['partner', 'smartremit_procedures']),
  holdDecider: z.enum(['partner', 'smartremit_delegated']),
  requireKycBeforeSend: z.literal(true),
  fourEyesNonSanctions: z.boolean(),
});

const certificationSchema = z.object({
  certifiedAt: timestamp,
  certifiedBy: text,
  revokedAt: timestamp.optional(),
  revokedBy: text.optional(),
});

const contractSchema = z.object({
  ref: text,
  signedOn: dateOnly,
  recordedBy: text,
  recordedAt: timestamp,
});

const optInSchema = z.object({
  counselRef: text.optional(),
  counselBy: text.optional(),
  counselAt: timestamp.optional(),
  partnerApprovedBy: text.optional(),
  partnerApprovedAt: timestamp.optional(),
});

const complianceUsersSchema = z.array(z.string().regex(/^[a-z0-9._-]{1,64}$/));

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseOptIns(raw: unknown): LiveControls['optIns'] {
  const out: LiveControls['optIns'] = {};
  if (!isPlainObject(raw)) return out;
  for (const cap of LIVE_CAPABILITIES) {
    if (!Object.prototype.hasOwnProperty.call(raw, cap)) continue;
    try {
      const r = optInSchema.safeParse(raw[cap]);
      if (r.success) out[cap] = r.data;
    } catch {
      // A throwing value reads as absent: this capability stays closed.
    }
  }
  return out;
}

function parseComplianceUsers(raw: unknown): string[] {
  const r = complianceUsersSchema.safeParse(raw);
  if (!r.success) return [];
  const deduped = [...new Set(r.data)];
  return deduped.length > MAX_COMPLIANCE_USERS ? [] : deduped;
}

/** Never throws. A non-object root, or any unexpected failure, reads as EMPTY (a fresh copy). */
export function parseLiveControls(raw: unknown): LiveControls {
  try {
    if (!isPlainObject(raw)) return { optIns: {}, complianceUsers: [] };
    const out: LiveControls = {
      optIns: parseOptIns(raw.optIns),
      complianceUsers: parseComplianceUsers(raw.complianceUsers),
    };
    const posture = postureSchema.safeParse(raw.posture);
    if (posture.success) out.posture = posture.data;
    const certification = certificationSchema.safeParse(raw.certification);
    if (certification.success) out.certification = certification.data;
    const contract = contractSchema.safeParse(raw.contract);
    if (contract.success) out.contract = contract.data;
    for (const k of RESERVED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(raw, k)) out[k] = raw[k];
    }
    return out;
  } catch {
    return { optIns: {}, complianceUsers: [] };
  }
}

export function postureSigned(lc: LiveControls | undefined): boolean {
  return lc?.posture !== undefined;
}
