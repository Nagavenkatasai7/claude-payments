'use client';

import { useState, type FormEvent } from 'react';
import type { CountryCode } from '@/lib/types';
import {
  PAY_ACCOUNT_HOLDER_COPY,
  PAY_SENDER_ADDRESS_HINT,
  PAY_SENDER_ADDRESS_INVALID_COPY,
  PAY_SENDER_ADDRESS_LABEL,
  PAY_SENDER_DOB_INVALID_COPY,
  PAY_SENDER_DOB_LABEL,
  disclosureAckBody,
  payErrorMessage,
  payOkStatus,
} from '@/lib/pay-outcome';
// Type only: originator-info.ts is server code (database reads) and never enters the client bundle.
import type { OriginatorView } from '@/lib/originator-info';
import { approvingLine } from '@/lib/approving-line';
import { otpRequestErrorMessage } from '@/lib/otp-send-copy';
import { ACKNOWLEDGEMENT_LABEL } from '@/lib/legal/disclosure-drafts';
import {
  BANK_FIELDS_BY_COUNTRY,
  accountConfirmErrors,
  accountLast4,
  accountConfirmKey,
  accountConfirmLabel,
  composePayoutDestination,
  maskAccountDisplay,
  validatePayoutFields,
  type Field,
} from '@/lib/payout-format';

type Status = 'idle' | 'paying' | 'done' | 'inactive' | 'error';
type Step = 'details' | 'review';

export interface PaySummary {
  destAmount: number;
  destCurrency: string;
  sourceAmount: number;
  sourceCurrency: string;
  sourceTotalCharge: number;
}

/**
 * Fix pack 4 (C15): the figures of the 'Approving ...' line, from the server
 * page (the total it shows, the recipient name it shows, and a last4 only
 * where it shows the saved account label today, for a bank account).
 */
export interface PayApproving {
  amountText: string;
  currency: string;
  recipientName: string;
  accountLast4: string | null;
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

// ── Tailwind conversion of the legacy WhatsApp-dark theme (legacy-themes.css) ─
// Exact visual identity. `leading-normal` pins line-height to the inherited
// 1.5 the legacy CSS relied on (named text-* utilities would otherwise set
// their own). Input font-size is 16px (NOT 15) so iOS Safari does not
// auto-zoom the viewport on focus — Safari zooms whenever a focused input's
// font-size is < 16px.
const inputClasses =
  'mt-1 w-full rounded-lg border border-[#2a3942] bg-[#2a3942] p-2.5 text-[16px] text-[#e9edef]';
// Single 6-digit code box: centered, wide tracking, 22px digits.
const otpInputClasses =
  'mt-1 w-full rounded-lg border border-[#2a3942] bg-[#2a3942] p-2.5 text-center text-[22px] tracking-[0.5em] text-[#e9edef] tabular-nums';
const labelClasses = 'mb-3 block text-[13px] text-[#8696a0]';
const primaryBtnClasses =
  'w-full cursor-pointer rounded-3xl bg-[#25d366] p-3 text-[15px] font-bold text-[#0b141a] disabled:cursor-default disabled:opacity-60';
const secondaryBtnClasses =
  'mt-2.5 w-full cursor-pointer rounded-3xl border border-[#2a3942] bg-transparent p-3 text-[15px] font-bold text-[#8696a0] disabled:cursor-default disabled:opacity-60';
const stepLabelClasses = 'mb-3.5 text-xs leading-normal uppercase tracking-[0.04em] text-[#8696a0]';
const fieldErrorClasses = 'mt-1 block text-xs leading-normal text-[#f15c6d]';
const formErrorClasses = 'mt-2 text-[13px] text-[#f15c6d]';
// Raj (Oct 7): "Resend code" is a small link under the pay button, not a second big button.
const resendLinkClasses =
  'mt-3 block w-full cursor-pointer bg-transparent p-1 text-center text-[13px] font-semibold text-[#53bdeb] underline-offset-2 hover:underline focus-visible:underline disabled:cursor-default disabled:opacity-60';
// Raj (Oct 7): the account number is typed hidden (dots). A text input with
// -webkit-text-security (every current browser; Firefox from 114, per MDN
// browser-compat-data) keeps the numeric keypad and does not invite the
// browser's password manager the way type="password" does.
const hiddenTextClasses = '[-webkit-text-security:disc]';
const showToggleClasses =
  'mb-3 cursor-pointer bg-transparent p-0 text-xs font-semibold text-[#53bdeb] underline-offset-2 hover:underline focus-visible:underline';
const successClasses = 'flex items-center justify-center gap-2 font-semibold text-[#25d366]';
const panelClasses = 'mb-5 rounded-xl bg-[#202c33] p-3.5';
const lineClasses = 'flex justify-between py-1.5 text-sm leading-normal';

export function PayForm({
  transferId,
  destinationCountry,
  needsBankDetails,
  recipientName,
  fundingMethod,
  summary,
  savedAccountLabel = null,
  bankDetailsLocked = false,
  disclosureVersion = null,
  disclosureHash = null,
  approving = null,
  legalNameRequired = false,
  legalNameOnFile = true,
  originator = NO_ORIGINATOR_VIEW,
}: {
  transferId: string;
  destinationCountry: CountryCode;
  needsBankDetails: boolean;
  recipientName: string;
  fundingMethod: string;
  summary: PaySummary;
  savedAccountLabel?: string | null;
  /** Stage C2: an AI-app-prepared draft pays only its saved account, so no "Edit bank details". */
  bankDetailsLocked?: boolean;
  /** Program-Fix 15 PR B: non-null ⇒ the page shows the Reg E disclosure and "Pay now" needs the acknowledgement. */
  disclosureVersion?: string | null;
  /** Fix pack 4 (C10): the hash of the provider block the page was rendered with (posted with the acknowledgement). */
  disclosureHash?: string | null;
  /** Fix pack 4 (C15): the 'Approving ...' line's figures; null shows no line. */
  approving?: PayApproving | null;
  /** Fix pack 4 (C18): the account-holder field is required WHEN SHOWN (real money, not exempt). */
  legalNameRequired?: boolean;
  /** Fix pack 4 (C18): a name is on file for the STORED account (or the row is exempt). Defaults: no field. */
  legalNameOnFile?: boolean;
  /** Fix pack 5 (P19): which sender fields to ask (booleans only). Default: none. The ACH (b2b) form never asks. */
  originator?: OriginatorView;
}) {
  // fix 6: the sender may replace a prefilled (server-rehydrated) destination.
  const [editBankDetails, setEditBankDetails] = useState(false);
  // B2B ACH-pull (NON-CUSTODIAL): the payer authorizes an ACH debit of their
  // business bank — the licensed partner pulls the funds, SmartRemit never
  // captures. Collect routing / account / account type, then OTP-confirm + pay.
  if (fundingMethod === 'ach_pull') {
    return (
      <AchDebitPayForm
        transferId={transferId}
        recipientName={recipientName}
        summary={summary}
        // C15: the ACH form never names an account (the payee account is not the payer's to see).
        approvingText={approving ? approvingLine({ ...approving, accountLast4: null }) : null}
      />
    );
  }
  // Scheduled / re-opened / cron links already carry the recipient's bank
  // details — keep today's single-step, no-body POST exactly as before. fix 6:
  // a prefilled consumer destination also offers "Edit bank details", which
  // switches to the two-step form below.
  if (!needsBankDetails && !editBankDetails) {
    return (
      <SimplePayForm
        transferId={transferId}
        disclosureVersion={disclosureVersion}
        disclosureHash={disclosureHash}
        approvingText={approving ? approvingLine(approving) : null}
        legalNameRequired={legalNameRequired}
        legalNameOnFile={legalNameOnFile}
        originator={originator}
        savedAccountLabel={savedAccountLabel}
        onEditBankDetails={savedAccountLabel && !bankDetailsLocked ? () => setEditBankDetails(true) : undefined}
      />
    );
  }
  // Cold-start draft (or "Edit bank details"): the sender enters the recipient's bank details here.
  return (
    <BankDetailsPayForm
      transferId={transferId}
      disclosureVersion={disclosureVersion}
      disclosureHash={disclosureHash}
      approving={approving}
      legalNameRequired={legalNameRequired}
      legalNameOnFile={legalNameOnFile}
      originator={originator}
      destinationCountry={destinationCountry}
      recipientName={recipientName}
      summary={summary}
    />
  );
}

// ── Phase 3 Part B: per-transaction OTP step-up (shared by both forms) ───────
// Sends a code to WhatsApp (free-form, in-session) and collects the 6 digits the
// sender enters. The parent includes `code` in its pay POST; a 403 reason:'otp'
// bounces here with an inline error.

interface OtpRequest {
  requesting: boolean;
  requestError: string;
  requestCode: () => Promise<void>;
}

/** Program-Fix 25 PR B: a refused code request says why (send failed / locked). */
function useOtpRequest(transferId: string, setSent: (v: boolean) => void): OtpRequest {
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState('');

  async function requestCode() {
    setRequesting(true);
    setRequestError('');
    try {
      const res = await fetch(`/api/pay/${transferId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request_otp' }),
      });
      if (res.ok) {
        setSent(true);
      } else {
        const data = (await res.json().catch(() => ({}))) as { reason?: unknown };
        setRequestError(otpRequestErrorMessage(data.reason));
      }
    } catch {
      /* leave !sent so the button stays available to retry */
      setRequestError(otpRequestErrorMessage(undefined));
    } finally {
      setRequesting(false);
    }
  }

  return { requesting, requestError, requestCode };
}

function OtpFields({
  code,
  setCode,
  sent,
  otpError,
  otp,
  approvingText = null,
}: {
  code: string;
  setCode: (v: string) => void;
  sent: boolean;
  otpError?: string;
  otp: OtpRequest;
  /** Fix pack 4 (C15): what the code approves, shown above the send button and above the code box. */
  approvingText?: string | null;
}) {
  const approvingEl = approvingText ? (
    <p data-testid="approving-line" className="mb-2 text-[13px] leading-normal text-[#e9edef]">{approvingText}</p>
  ) : null;
  if (!sent) {
    return (
      <div>
        {approvingEl}
        <button type="button" className={secondaryBtnClasses} onClick={otp.requestCode} disabled={otp.requesting}>
          {otp.requesting ? 'Sending…' : 'Send confirmation code to WhatsApp'}
        </button>
        {otp.requestError && <span className={fieldErrorClasses} role="alert">{otp.requestError}</span>}
      </div>
    );
  }
  return (
    <div>
      {approvingEl}
      <label className={labelClasses}>
        Confirmation code
        <input
          className={otpInputClasses}
          inputMode="numeric"
          maxLength={6}
          pattern="\d{6}"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="••••••"
          autoComplete="one-time-code"
          aria-label="6-digit confirmation code"
        />
      </label>
      {otpError && <span className={fieldErrorClasses}>{otpError}</span>}
    </div>
  );
}

/** Raj (Oct 7): drawn after the pay button, so the code box and "Pay now" sit together. */
function ResendCode({ sent, otp, disabled = false }: { sent: boolean; otp: OtpRequest; disabled?: boolean }) {
  if (!sent) return null;
  return (
    <div>
      <button type="button" className={resendLinkClasses} onClick={otp.requestCode} disabled={otp.requesting || disabled}>
        {otp.requesting ? 'Sending…' : 'Resend code'}
      </button>
      {otp.requestError && <span className={fieldErrorClasses} role="alert">{otp.requestError}</span>}
    </div>
  );
}

// ── Program-Fix 15 PR B: Reg E disclosure acknowledgement ────────────────────
// Rendered only when the page shows a disclosure (consumer transfers). The pay
// button stays disabled until it is ticked; the POST then carries the OPTIONAL
// `disclosureVersion` (the server records it, never requires it — B3).

function DisclosureAck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="mt-3 mb-3 flex items-start gap-2 text-[13px] leading-normal text-[#e9edef]">
      <input
        type="checkbox"
        name="disclosureAck"
        className="mt-0.5 size-4 shrink-0 accent-[#25d366]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{ACKNOWLEDGEMENT_LABEL}</span>
    </label>
  );
}

// ── Fix pack 4 (C18, C14): the recipient's account-holder name ──────────────
// Shown only where the page asks for it; never pre-filled (no stored name ever
// reaches the browser). Posted as `accountHolder` only when shown.

function AccountHolderField({
  value,
  onChange,
  required,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  required: boolean;
  error?: string;
}) {
  return (
    <label className={labelClasses}>
      Account holder name
      <input
        className={inputClasses}
        name="accountHolder"
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={80}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <span data-testid="account-holder-help" className="mt-1 block text-xs leading-normal text-[#8696a0]">
        As it appears on the recipient&apos;s bank account.
      </span>
      {error && <span className={fieldErrorClasses}>{error}</span>}
    </label>
  );
}

// ── Fix pack 5 (P19, P31): the sender's home address and date of birth ──────
// Shown only where the page asks (real money, b2c, not exempt, not routed, not
// on file); never pre-filled (no stored value ever reaches the browser), and
// posted as `senderAddress` / `senderDob` only when shown. A 400
// originator_invalid shows the fixed copy under its field.

/** Nothing asked (the client-side twin of NO_ORIGINATOR_FIELDS; the server module is not imported here). */
const NO_ORIGINATOR_VIEW: OriginatorView = Object.freeze({
  addressRequired: false,
  addressOnFile: true,
  dobRequired: false,
  dobOnFile: true,
});

export interface OriginatorShown {
  address: boolean;
  dob: boolean;
}

/** A field shows when it is required and not on file (P19). */
export function originatorShown(v: OriginatorView): OriginatorShown {
  return { address: v.addressRequired && !v.addressOnFile, dob: v.dobRequired && !v.dobOnFile };
}

/** The pay body keys: only the shown fields, trimmed. */
export function originatorBody(
  shown: OriginatorShown,
  values: { address: string; dob: string },
): { senderAddress?: string; senderDob?: string } {
  return {
    ...(shown.address ? { senderAddress: values.address.trim() } : {}),
    ...(shown.dob ? { senderDob: values.dob.trim() } : {}),
  };
}

/** A shown field left empty: the pay / continue button waits for it. */
export function originatorMissing(shown: OriginatorShown, values: { address: string; dob: string }): boolean {
  return (shown.address && values.address.trim() === '') || (shown.dob && values.dob.trim() === '');
}

/** The route's 400 fieldErrors -> the fixed copy per field (never the server's text). */
export function originatorFieldErrors(fieldErrors: unknown): { senderAddress?: string; senderDob?: string } {
  if (!fieldErrors || typeof fieldErrors !== 'object') return {};
  const f = fieldErrors as Record<string, unknown>;
  return {
    ...(f.senderAddress !== undefined ? { senderAddress: PAY_SENDER_ADDRESS_INVALID_COPY } : {}),
    ...(f.senderDob !== undefined ? { senderDob: PAY_SENDER_DOB_INVALID_COPY } : {}),
  };
}

export function OriginatorFields({
  shown,
  address,
  dob,
  onAddress,
  onDob,
  errors = {},
}: {
  shown: OriginatorShown;
  address: string;
  dob: string;
  onAddress: (v: string) => void;
  onDob: (v: string) => void;
  errors?: { senderAddress?: string; senderDob?: string };
}) {
  if (!shown.address && !shown.dob) return null;
  return (
    <>
      {shown.address && (
        <label className={labelClasses}>
          {PAY_SENDER_ADDRESS_LABEL}
          <input
            className={inputClasses}
            name="senderAddress"
            required
            value={address}
            onChange={(e) => onAddress(e.target.value)}
            maxLength={300}
            autoComplete="street-address"
          />
          <span data-testid="sender-address-help" className="mt-1 block text-xs leading-normal text-[#8696a0]">
            {PAY_SENDER_ADDRESS_HINT}
          </span>
          {errors.senderAddress && <span className={fieldErrorClasses}>{errors.senderAddress}</span>}
        </label>
      )}
      {shown.dob && (
        <label className={labelClasses}>
          {PAY_SENDER_DOB_LABEL}
          <input
            className={inputClasses}
            name="senderDob"
            type="text"
            required
            value={dob}
            onChange={(e) => onDob(e.target.value)}
            placeholder="YYYY-MM-DD"
            inputMode="numeric"
            maxLength={10}
            autoComplete="bday"
          />
          {errors.senderDob && <span className={fieldErrorClasses}>{errors.senderDob}</span>}
        </label>
      )}
    </>
  );
}

// ── Single-step path (scheduled / re-opened links) ──────────────────────────

function SimplePayForm({
  transferId,
  savedAccountLabel = null,
  onEditBankDetails,
  disclosureVersion = null,
  disclosureHash = null,
  approvingText = null,
  legalNameRequired = false,
  legalNameOnFile = true,
  originator = NO_ORIGINATOR_VIEW,
}: {
  transferId: string;
  savedAccountLabel?: string | null;
  onEditBankDetails?: () => void;
  disclosureVersion?: string | null;
  disclosureHash?: string | null;
  approvingText?: string | null;
  legalNameRequired?: boolean;
  legalNameOnFile?: boolean;
  originator?: OriginatorView;
}) {
  const [status, setStatus] = useState<Status>('idle');
  const [acked, setAcked] = useState(false);
  const ackMissing = disclosureVersion !== null && !acked;
  // Fix pack 4 (C18): the stored account has no name on file -> ask for it here.
  const showHolder = !legalNameOnFile;
  const [holder, setHolder] = useState('');
  const [holderError, setHolderError] = useState('');
  const holderMissing = showHolder && legalNameRequired && holder.trim() === '';
  // Fix pack 5 (P19): the sender's address / DOB when asked.
  const shownOrig = originatorShown(originator);
  const [senderAddress, setSenderAddress] = useState('');
  const [senderDob, setSenderDob] = useState('');
  const [origErrors, setOrigErrors] = useState<{ senderAddress?: string; senderDob?: string }>({});
  const origMissing = originatorMissing(shownOrig, { address: senderAddress, dob: senderDob });
  const origError = !!(origErrors.senderAddress || origErrors.senderDob);
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const otp = useOtpRequest(transferId, setSent);
  const [otpError, setOtpError] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (ackMissing || holderMissing || origMissing) return; // the button is disabled too; this covers implicit (Enter) submission
    setStatus('paying');
    setOtpError('');
    setHolderError('');
    setOrigErrors({});
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/pay/${transferId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          otp: code,
          ...disclosureAckBody(disclosureVersion, disclosureHash, acked),
          ...(showHolder ? { accountHolder: holder.trim() } : {}),
          ...originatorBody(shownOrig, { address: senderAddress, dob: senderDob }),
        }),
      });
      if (res.ok) {
        // Review S2 (Program-Fix 32): a 200 { status: 'cancelled' } is a dead link, not a payment.
        setStatus(payOkStatus(await res.json().catch(() => null)));
        return;
      }
      try {
        const data = (await res.json()) as {
          reason?: string;
          fieldErrors?: { accountHolder?: unknown; senderAddress?: unknown; senderDob?: unknown };
        };
        setErrorMessage(payErrorMessage(data));
        if (data.reason === 'otp') setOtpError('That code is incorrect or expired — resend and try again.');
        // Fix pack 4 (C14): an account-holder 400 shows under the field, not under the code.
        if (data.fieldErrors?.accountHolder !== undefined) setHolderError(PAY_ACCOUNT_HOLDER_COPY);
        // Fix pack 5 (P31): an originator 400 shows its fixed copy under the field.
        setOrigErrors(originatorFieldErrors(data.fieldErrors));
        // Fix pack 4 (C14): the code is spent; the copy says to tap Resend.
        if (data.reason === 'approval_not_recorded') setCode('');
      } catch {
        /* generic */
      }
      setStatus('error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'inactive') {
    return <p className={formErrorClasses}>This link is no longer active.</p>;
  }

  if (status === 'done') {
    return (
      <p className={successClasses}>
        {/* Inline SVG check (not the ✅ emoji) so the success state renders
            identically on Windows / macOS / Android — emoji glyphs vary per OS. */}
        <svg
          className="shrink-0"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12.5l2.5 2.5L16 9" />
        </svg>
        Payment complete! Check WhatsApp for your receipt.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      {savedAccountLabel && (
        <div className={panelClasses}>
          <div className={lineClasses}>
            <span className="text-[#8696a0]">Paying to</span>
            <span>{savedAccountLabel}</span>
          </div>
        </div>
      )}
      {showHolder && (
        <AccountHolderField
          value={holder}
          onChange={(v) => {
            setHolder(v);
            if (holderError) setHolderError('');
          }}
          required={legalNameRequired}
          error={holderError}
        />
      )}
      <OriginatorFields
        shown={shownOrig}
        address={senderAddress}
        dob={senderDob}
        onAddress={(v) => {
          setSenderAddress(v);
          if (origErrors.senderAddress) setOrigErrors((p) => ({ ...p, senderAddress: undefined }));
        }}
        onDob={(v) => {
          setSenderDob(v);
          if (origErrors.senderDob) setOrigErrors((p) => ({ ...p, senderDob: undefined }));
        }}
        errors={origErrors}
      />
      <OtpFields code={code} setCode={setCode} sent={sent} otpError={otpError} otp={otp} approvingText={approvingText} />
      {disclosureVersion !== null && <DisclosureAck checked={acked} onChange={setAcked} />}
      <button
        type="submit"
        className={primaryBtnClasses}
        disabled={status === 'paying' || !sent || code.length !== 6 || ackMissing || holderMissing || origMissing}
      >
        {status === 'paying' ? 'Processing…' : 'Pay now'}
      </button>
      <ResendCode sent={sent} otp={otp} disabled={status === 'paying'} />
      {onEditBankDetails && (
        <button type="button" className={secondaryBtnClasses} onClick={onEditBankDetails} disabled={status === 'paying'}>
          Edit bank details
        </button>
      )}
      {status === 'error' && !otpError && !holderError && !origError && (
        <p className={formErrorClasses}>{errorMessage ?? 'Something went wrong. Please try again.'}</p>
      )}
    </form>
  );
}

// ── Two-step path: Step 1 collect recipient bank details, Step 2 review+pay ──

function BankDetailsPayForm({
  transferId,
  destinationCountry,
  recipientName,
  summary,
  disclosureVersion = null,
  disclosureHash = null,
  approving = null,
  legalNameRequired = false,
  legalNameOnFile = true,
  originator = NO_ORIGINATOR_VIEW,
}: {
  transferId: string;
  destinationCountry: CountryCode;
  recipientName: string;
  summary: PaySummary;
  disclosureVersion?: string | null;
  disclosureHash?: string | null;
  approving?: PayApproving | null;
  legalNameRequired?: boolean;
  legalNameOnFile?: boolean;
  originator?: OriginatorView;
}) {
  const defs: Field[] = BANK_FIELDS_BY_COUNTRY[destinationCountry] ?? [];

  const [step, setStep] = useState<Step>('details');
  const [status, setStatus] = useState<Status>('idle');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(defs.map((d) => [d.key, ''])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Raj (Oct 7): the re-enter box value per account field. Never sent: it only has to match.
  const [confirms, setConfirms] = useState<Record<string, string>>({});
  const [showAccount, setShowAccount] = useState(false);
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const otp = useOtpRequest(transferId, setSent);
  const [otpError, setOtpError] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [acked, setAcked] = useState(false);
  const ackMissing = disclosureVersion !== null && !acked;
  // Fix pack 4 (C18): a name on file describes the STORED account, not the one
  // typed here, so on real money the field shows even with a name on file. An
  // exempt row ({ required: false, onFile: true }) never shows it.
  const showHolder = legalNameRequired || !legalNameOnFile;
  const [holder, setHolder] = useState('');
  // Fix pack 5 (P19): the sender's address / DOB when asked, on step 1 (errors in `errors`).
  const shownOrig = originatorShown(originator);
  const [senderAddress, setSenderAddress] = useState('');
  const [senderDob, setSenderDob] = useState('');

  function setOriginatorValue(key: 'senderAddress' | 'senderDob', v: string) {
    if (key === 'senderAddress') setSenderAddress(v);
    else setSenderDob(v);
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: '' }));
  }

  function setHolderValue(v: string) {
    setHolder(v);
    if (errors.accountHolder) setErrors((prev) => ({ ...prev, accountHolder: '' }));
  }

  function setField(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: '' }));
  }

  function setConfirm(key: string, v: string) {
    setConfirms((prev) => ({ ...prev, [key]: v }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: '' }));
  }

  // Step 1 → Step 2: client-side validate via the SAME validator the server
  // re-runs authoritatively (single source of truth, no drift).
  function handleContinue(e: FormEvent) {
    e.preventDefault();
    const result = validatePayoutFields(destinationCountry, values);
    const confirmErrors = accountConfirmErrors(destinationCountry, { ...values, ...confirms });
    const holderErrors: Record<string, string> =
      showHolder && legalNameRequired && holder.trim() === '' ? { accountHolder: PAY_ACCOUNT_HOLDER_COPY } : {};
    const origErrors: Record<string, string> = {
      ...(shownOrig.address && senderAddress.trim() === '' ? { senderAddress: PAY_SENDER_ADDRESS_INVALID_COPY } : {}),
      ...(shownOrig.dob && senderDob.trim() === '' ? { senderDob: PAY_SENDER_DOB_INVALID_COPY } : {}),
    };
    if (
      !result.ok ||
      Object.keys(confirmErrors).length > 0 ||
      Object.keys(holderErrors).length > 0 ||
      Object.keys(origErrors).length > 0
    ) {
      setErrors({ ...(result.ok ? {} : result.errors), ...confirmErrors, ...holderErrors, ...origErrors });
      return;
    }
    setErrors({});
    setStep('review');
  }

  // Step 2: POST { country, fields }. The route re-validates and composes the
  // canonical payoutDestination server-side (it never trusts a client-composed
  // string), so we send the raw fields, not the composed string.
  async function handlePay() {
    if (ackMissing) return;
    setStatus('paying');
    setOtpError('');
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/pay/${transferId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          country: destinationCountry,
          fields: values,
          otp: code,
          ...disclosureAckBody(disclosureVersion, disclosureHash, acked),
          ...(showHolder ? { accountHolder: holder.trim() } : {}),
          ...originatorBody(shownOrig, { address: senderAddress, dob: senderDob }),
        }),
      });
      if (res.ok) {
        // Review S2 (Program-Fix 32): a 200 { status: 'cancelled' } is a dead link, not a payment.
        setStatus(payOkStatus(await res.json().catch(() => null)));
        return;
      }
      // Surface server-side errors: a wrong/expired OTP stays on the review step;
      // a bank-field error bounces back to Step 1 so the sender can fix it.
      try {
        const data = (await res.json()) as { fieldErrors?: Record<string, string>; reason?: string };
        setErrorMessage(payErrorMessage(data));
        if (data.reason === 'otp') {
          setOtpError('That code is incorrect or expired — resend and try again.');
        } else if (data.reason === 'approval_not_recorded') {
          setCode(''); // Fix pack 4 (C14): the code is spent; the copy says to tap Resend.
        } else if (data.fieldErrors) {
          // Fix pack 5 (P31): an originator field error shows its fixed copy.
          setErrors({ ...data.fieldErrors, ...originatorFieldErrors(data.fieldErrors) });
          setStep('details');
        }
      } catch {
        /* non-JSON error body — fall through to the generic error message */
      }
      setStatus('error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'inactive') {
    return <p className={formErrorClasses}>This link is no longer active.</p>;
  }

  if (status === 'done') {
    return (
      <p className={successClasses}>
        {/* Inline SVG check (not the ✅ emoji) so the success state renders
            identically on Windows / macOS / Android — emoji glyphs vary per OS. */}
        <svg
          className="shrink-0"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12.5l2.5 2.5L16 9" />
        </svg>
        Payment complete! Check WhatsApp for your receipt.
      </p>
    );
  }

  if (step === 'review') {
    const composed = composePayoutDestination(destinationCountry, values);
    const masked = maskAccountDisplay(composed);
    // Fix pack 4 (C15): the typed account's last 4 (already in this browser),
    // only when this form collects a bank account (every country's field list
    // marks one; a UPI id is never entered here).
    const isBankAccount = defs.some((d) => d.isAccount);
    const approvingText = approving
      ? approvingLine({ ...approving, accountLast4: isBankAccount ? accountLast4(composed) || null : null })
      : null;
    return (
      <div>
        <div className={stepLabelClasses}>Step 2 of 2 · Review &amp; pay</div>
        <div className={panelClasses}>
          <div className={lineClasses}>
            <span className="text-[#8696a0]">To</span>
            <span>{recipientName}</span>
          </div>
          <div className={lineClasses}>
            <span className="text-[#8696a0]">They receive</span>
            <span>{formatMoney(summary.destAmount, summary.destCurrency)}</span>
          </div>
          <div className={lineClasses}>
            <span className="text-[#8696a0]">Bank account</span>
            <span>{masked}</span>
          </div>
          <div className={lineClasses} style={{ fontWeight: 700 }}>
            <span className="text-[#8696a0]">Total charge</span>
            <span>{formatMoney(summary.sourceTotalCharge, summary.sourceCurrency)}</span>
          </div>
        </div>
        <OtpFields code={code} setCode={setCode} sent={sent} otpError={otpError} otp={otp} approvingText={approvingText} />
        {disclosureVersion !== null && <DisclosureAck checked={acked} onChange={setAcked} />}
        <button type="button" className={primaryBtnClasses} onClick={handlePay} disabled={status === 'paying' || !sent || code.length !== 6 || ackMissing}>
          {status === 'paying' ? 'Processing…' : 'Pay now'}
        </button>
        <ResendCode sent={sent} otp={otp} disabled={status === 'paying'} />
        <button
          type="button"
          className={secondaryBtnClasses}
          onClick={() => {
            setStatus('idle');
            setStep('details');
          }}
          disabled={status === 'paying'}
        >
          Edit bank details
        </button>
        {status === 'error' && !otpError && (
          <p className={formErrorClasses}>{errorMessage ?? 'Something went wrong. Please try again.'}</p>
        )}
      </div>
    );
  }

  // Step 1: per-country recipient bank-details form.
  return (
    <form onSubmit={handleContinue}>
      <div className={stepLabelClasses}>Step 1 of 2 · Recipient bank details</div>
      {defs.map((def) => {
        const digitOnly = typeof def.digits === 'number';
        if (def.isAccount) {
          // Raj (Oct 7): typed hidden, with Show / Hide, then a re-enter box that must match.
          const confirmKey = accountConfirmKey(def.key);
          const boxClasses = showAccount ? inputClasses : `${inputClasses} ${hiddenTextClasses}`;
          // An IBAN holds letters; every other account field is digits.
          const accountInputMode = def.pattern ? 'text' : 'numeric';
          return (
            <div key={def.key}>
              <label className={labelClasses}>
                {def.label}
                <input
                  className={boxClasses}
                  name={def.key}
                  required
                  value={values[def.key] ?? ''}
                  onChange={(e) => setField(def.key, e.target.value)}
                  inputMode={accountInputMode}
                  maxLength={digitOnly ? def.digits : undefined}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {errors[def.key] && <span className={fieldErrorClasses}>{errors[def.key]}</span>}
              </label>
              <label className={labelClasses}>
                {accountConfirmLabel(def.label)}
                <input
                  className={boxClasses}
                  name={confirmKey}
                  required
                  value={confirms[confirmKey] ?? ''}
                  onChange={(e) => setConfirm(confirmKey, e.target.value)}
                  inputMode={accountInputMode}
                  maxLength={digitOnly ? def.digits : undefined}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {errors[confirmKey] && <span className={fieldErrorClasses}>{errors[confirmKey]}</span>}
              </label>
              <button
                type="button"
                className={showToggleClasses}
                onClick={() => setShowAccount((v) => !v)}
                aria-pressed={showAccount}
                aria-label={`${showAccount ? 'Hide' : 'Show'} ${def.label}`}
              >
                {showAccount ? 'Hide' : 'Show'}
              </button>
            </div>
          );
        }
        return (
          <label key={def.key} className={labelClasses}>
            {def.label}
            <input
              className={inputClasses}
              name={def.key}
              required
              value={values[def.key] ?? ''}
              onChange={(e) => setField(def.key, e.target.value)}
              inputMode={digitOnly ? 'numeric' : 'text'}
              maxLength={digitOnly ? def.digits : undefined}
              autoComplete="off"
            />
            {errors[def.key] && <span className={fieldErrorClasses}>{errors[def.key]}</span>}
          </label>
        );
      })}
      {showHolder && (
        <AccountHolderField
          value={holder}
          onChange={setHolderValue}
          required={legalNameRequired}
          error={errors.accountHolder || undefined}
        />
      )}
      <OriginatorFields
        shown={shownOrig}
        address={senderAddress}
        dob={senderDob}
        onAddress={(v) => setOriginatorValue('senderAddress', v)}
        onDob={(v) => setOriginatorValue('senderDob', v)}
        errors={{ senderAddress: errors.senderAddress || undefined, senderDob: errors.senderDob || undefined }}
      />
      <button type="submit" className={primaryBtnClasses}>Continue</button>
    </form>
  );
}

// ── B2B ACH-pull path (NON-CUSTODIAL) ────────────────────────────────────────
// The payer authorizes a one-time ACH debit of their BUSINESS bank. SmartRemit
// never captures the funds — the licensed partner pulls them via the signed
// settlement instruction. We collect routing / account / account type, OTP-
// confirm, then POST { ach, otp }; the route tokenizes the bank fields into an
// opaque mandate (raw digits never stored) and proceeds straight to settlement.

const selectClasses =
  'mt-1 w-full rounded-lg border border-[#2a3942] bg-[#2a3942] p-2.5 text-[16px] text-[#e9edef]';

function AchDebitPayForm({
  transferId,
  recipientName,
  summary,
  approvingText = null,
}: {
  transferId: string;
  recipientName: string;
  summary: PaySummary;
  approvingText?: string | null;
}) {
  const [status, setStatus] = useState<Status>('idle');
  const [routingNumber, setRoutingNumber] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountType, setAccountType] = useState<'checking' | 'savings'>('checking');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const otp = useOtpRequest(transferId, setSent);
  const [otpError, setOtpError] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Mirror the server's checks (the route re-validates authoritatively).
  function clientErrors(): Record<string, string> {
    const e: Record<string, string> = {};
    if (routingNumber.replace(/\D/g, '').length !== 9) e.routingNumber = 'Enter the 9-digit routing number.';
    if (accountNumber.replace(/\D/g, '').length < 4) e.accountNumber = 'Enter a valid account number.';
    return e;
  }

  async function handlePay(e: FormEvent) {
    e.preventDefault();
    const e0 = clientErrors();
    if (Object.keys(e0).length > 0) {
      setErrors(e0);
      return;
    }
    setErrors({});
    setStatus('paying');
    setOtpError('');
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/pay/${transferId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ach: { routingNumber, accountNumber, accountType }, otp: code }),
      });
      if (res.ok) {
        // Review S2 (Program-Fix 32): a 200 { status: 'cancelled' } is a dead link, not a payment.
        setStatus(payOkStatus(await res.json().catch(() => null)));
        return;
      }
      try {
        const data = (await res.json()) as { fieldErrors?: Record<string, string>; reason?: string };
        setErrorMessage(payErrorMessage(data));
        if (data.reason === 'otp') {
          setOtpError('That code is incorrect or expired — resend and try again.');
        } else if (data.reason === 'approval_not_recorded') {
          setCode(''); // Fix pack 4 (C14): the code is spent; the copy says to tap Resend.
        } else if (data.fieldErrors) {
          setErrors(data.fieldErrors);
        }
      } catch {
        /* non-JSON error body — fall through to the generic error message */
      }
      setStatus('error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'inactive') {
    return <p className={formErrorClasses}>This link is no longer active.</p>;
  }

  if (status === 'done') {
    return (
      <p className={successClasses}>
        {/* Inline SVG check (not the ✅ emoji) so the success state renders
            identically on Windows / macOS / Android — emoji glyphs vary per OS. */}
        <svg
          className="shrink-0"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12.5l2.5 2.5L16 9" />
        </svg>
        Payment authorized! Check WhatsApp for your receipt.
      </p>
    );
  }

  return (
    <form onSubmit={handlePay}>
      <div className={stepLabelClasses}>Authorize ACH bank debit</div>
      <p className="mb-4 text-[13px] leading-normal text-[#8696a0]">
        We&rsquo;ll debit {formatMoney(summary.sourceTotalCharge, summary.sourceCurrency)} from your
        business account to settle with {recipientName}.
      </p>
      <label className={labelClasses}>
        Routing number
        <input
          className={inputClasses}
          name="routingNumber"
          required
          value={routingNumber}
          onChange={(e) => {
            setRoutingNumber(e.target.value.replace(/\D/g, ''));
            if (errors.routingNumber) setErrors((p) => ({ ...p, routingNumber: '' }));
          }}
          inputMode="numeric"
          maxLength={9}
          autoComplete="off"
        />
        {errors.routingNumber && <span className={fieldErrorClasses}>{errors.routingNumber}</span>}
      </label>
      <label className={labelClasses}>
        Account number
        <input
          className={inputClasses}
          name="accountNumber"
          required
          value={accountNumber}
          onChange={(e) => {
            setAccountNumber(e.target.value.replace(/\D/g, ''));
            if (errors.accountNumber) setErrors((p) => ({ ...p, accountNumber: '' }));
          }}
          inputMode="numeric"
          maxLength={17}
          autoComplete="off"
        />
        {errors.accountNumber && <span className={fieldErrorClasses}>{errors.accountNumber}</span>}
      </label>
      <label className={labelClasses}>
        Account type
        <select
          className={selectClasses}
          name="accountType"
          value={accountType}
          onChange={(e) => setAccountType(e.target.value === 'savings' ? 'savings' : 'checking')}
        >
          <option value="checking">Checking</option>
          <option value="savings">Savings</option>
        </select>
        {errors.accountType && <span className={fieldErrorClasses}>{errors.accountType}</span>}
      </label>
      <OtpFields code={code} setCode={setCode} sent={sent} otpError={otpError} otp={otp} approvingText={approvingText} />
      <button type="submit" className={primaryBtnClasses} disabled={status === 'paying' || !sent || code.length !== 6}>
        {status === 'paying' ? 'Processing…' : 'Authorize & pay'}
      </button>
      <ResendCode sent={sent} otp={otp} disabled={status === 'paying'} />
      {status === 'error' && !otpError && (
        <p className={formErrorClasses}>{errorMessage ?? 'Something went wrong. Please try again.'}</p>
      )}
    </form>
  );
}
