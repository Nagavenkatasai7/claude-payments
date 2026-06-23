'use client';

import { useRef, useState } from 'react';
import { submitPartnerApplicationAction } from './actions';

// PartnerApplicationForm — the long, grouped detailed-application form (4 sections).
// On submit it first POSTs each selected file to /api/partner-application/upload
// (collecting {label,url,size,contentType} refs), then hands the text fields +
// a hidden `documents` JSON to the server action. Uploads are OPTIONAL: a failed
// upload surfaces a message but never blocks submitting the text application.
// Field `name=` attributes match PartnerApplicationDetails exactly.

interface Prefill {
  companyName: string;
  email: string;
  phone: string;
}

interface DocRef {
  label: string;
  url: string;
  size: number;
  contentType: string;
}

const INPUT =
  'min-h-[46px] w-full rounded-xl border border-white/10 bg-[#0b0e12] px-4 text-[16px] text-[#f5f7f8] placeholder:text-[#5b6470]';
const TEXTAREA =
  'w-full resize-y rounded-xl border border-white/10 bg-[#0b0e12] px-4 py-3 text-[16px] text-[#f5f7f8] placeholder:text-[#5b6470]';
const LABEL = 'text-[13px] font-semibold text-[#f5f7f8]';

const DOC_SLOTS = [
  { id: 'doc_license', label: 'Money-transmitter license' },
  { id: 'doc_incorporation', label: 'Certificate of incorporation' },
  { id: 'doc_aml', label: 'AML / compliance policy' },
  { id: 'doc_address', label: 'Proof of address' },
] as const;

const ACCEPT = 'application/pdf,image/png,image/jpeg';

function Field({
  name,
  label,
  type = 'text',
  placeholder,
  optional,
  required,
}: {
  name: string;
  label: string;
  type?: string;
  placeholder?: string;
  optional?: boolean;
  required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={name} className={LABEL}>
        {label}
        {required && (
          <span className="text-[#25d366]" aria-hidden="true">
            {' '}
            *
          </span>
        )}
        {optional && <span className="font-normal text-[#5b6470]"> (optional)</span>}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        placeholder={placeholder}
        required={required}
        className={INPUT}
      />
    </div>
  );
}

function TextField({
  name,
  label,
  placeholder,
  rows = 3,
}: {
  name: string;
  label: string;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={name} className={LABEL}>
        {label} <span className="font-normal text-[#5b6470]">(optional)</span>
      </label>
      <textarea id={name} name={name} rows={rows} placeholder={placeholder} className={TEXTAREA} />
    </div>
  );
}

function Section({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 sm:p-7">
      <legend className="px-2 text-[15px] font-bold text-[#25d366]">
        {n}. {title}
      </legend>
      <div className="mt-2 grid grid-cols-1 gap-5 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

// Server-side rejection reasons echoed back via ?error=… (the page reads the
// search param and passes it down so a bounced submit isn't a silent dead-end).
const ERROR_MESSAGES: Record<string, string> = {
  missing:
    'Please complete the required fields — legal entity name, country of incorporation, and primary contact.',
  rate: 'Too many submissions — please wait a little while and try again.',
};

export function PartnerApplicationForm({
  token,
  prefill,
  error,
}: {
  token: string;
  prefill: Prefill;
  error?: string;
}) {
  const serverError = error ? (ERROR_MESSAGES[error] ?? 'Something went wrong — please try again.') : null;
  const formRef = useRef<HTMLFormElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setSubmitting(true);
    setUploadError(null);

    // 1) Upload any selected files first; collect refs. Failures are non-fatal —
    //    we surface a message but still submit the text application.
    const refs: DocRef[] = [];
    const failures: string[] = [];
    for (const slot of DOC_SLOTS) {
      const input = form.elements.namedItem(slot.id) as HTMLInputElement | null;
      const file = input?.files?.[0];
      if (!file) continue;
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('label', slot.label);
        const res = await fetch(
          `/api/partner-application/upload?token=${encodeURIComponent(token)}`,
          { method: 'POST', body: fd },
        );
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          doc?: DocRef;
          error?: string;
        };
        if (res.ok && json.ok && json.doc) {
          refs.push(json.doc);
        } else {
          failures.push(`${slot.label}: ${json.error ?? 'upload failed'}`);
        }
      } catch {
        failures.push(`${slot.label}: upload failed`);
      }
    }

    if (failures.length > 0) {
      setUploadError(
        `Some documents could not be uploaded (${failures.join('; ')}). ` +
          'You can still submit your application — we will follow up for any missing documents.',
      );
    }

    // 2) Hand the text fields + the uploaded refs to the server action.
    const fd = new FormData(form);
    // Strip the file inputs from the action payload (they are uploaded already).
    for (const slot of DOC_SLOTS) fd.delete(slot.id);
    fd.set('documents', JSON.stringify(refs));
    // On success the action redirect()s and Next drives the navigation, so we do
    // NOT re-enable the button here (it would invite a duplicate submit during the
    // in-flight navigation). Only re-enable if the action itself rejected — the
    // page then re-renders with ?error=… and the user can correct + retry.
    try {
      await submitPartnerApplicationAction(fd);
    } catch {
      setSubmitting(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-6">
      <input type="hidden" name="token" value={token} />

      {serverError && (
        <p
          role="alert"
          className="rounded-xl border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.08)] px-4 py-3 text-[14px] text-[#f4c7c7]"
        >
          {serverError}
        </p>
      )}

      {/* Read-only context from the original lead. */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <p className="mb-3 text-[12.5px] font-semibold uppercase tracking-wide text-[#8b94a0]">
          Applying as
        </p>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-[12px] text-[#5b6470]">Company</dt>
            <dd className="text-[15px] text-[#f5f7f8]">{prefill.companyName}</dd>
          </div>
          <div>
            <dt className="text-[12px] text-[#5b6470]">Email</dt>
            <dd className="break-all text-[15px] text-[#f5f7f8]">{prefill.email}</dd>
          </div>
          <div>
            <dt className="text-[12px] text-[#5b6470]">Phone</dt>
            <dd className="text-[15px] text-[#f5f7f8]">{prefill.phone}</dd>
          </div>
        </dl>
      </div>

      <Section n={1} title="Company & legal entity">
        <Field name="legalName" label="Legal entity name" required placeholder="Acme Remit Inc." />
        <Field name="tradingName" label="Trading name" optional placeholder="Acme Money" />
        <Field name="registrationNumber" label="Registration / company number" optional />
        <Field
          name="countryOfIncorporation"
          label="Country of incorporation"
          required
          placeholder="United States"
        />
        <div className="sm:col-span-2">
          <TextField
            name="registeredAddress"
            label="Registered address"
            rows={2}
            placeholder="Street, city, state, postal code, country"
          />
        </div>
        <Field name="website" label="Website" type="url" optional placeholder="https://" />
        <Field name="yearEstablished" label="Year established" optional placeholder="2018" />
        <div className="sm:col-span-2">
          <TextField
            name="ownership"
            label="Ownership / beneficial owners"
            placeholder="Names and % holdings of beneficial owners (≥25%)"
          />
        </div>
      </Section>

      <Section n={2} title="Licensing, regulation & compliance">
        <div className="flex flex-col gap-2">
          <label htmlFor="isLicensed" className={LABEL}>
            Are you a licensed money transmitter?
          </label>
          <select id="isLicensed" name="isLicensed" className={INPUT} defaultValue="">
            <option value="" disabled>
              Select…
            </option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
            <option value="in_progress">Application in progress</option>
          </select>
        </div>
        <Field name="primaryRegulator" label="Primary regulator" optional placeholder="e.g. FinCEN, FCA" />
        <div className="sm:col-span-2">
          <TextField
            name="licenseTypes"
            label="License types / numbers held"
            placeholder="State MTLs, EMI, PI, etc. with numbers where applicable"
          />
        </div>
        <div className="sm:col-span-2">
          <TextField
            name="otherJurisdictions"
            label="Other jurisdictions you operate in"
            rows={2}
          />
        </div>
        <Field name="complianceOfficerName" label="Compliance officer name" optional />
        <Field
          name="complianceOfficerEmail"
          label="Compliance officer email"
          type="email"
          optional
        />
        <Field name="lastAuditDate" label="Last AML audit date" optional placeholder="YYYY-MM" />
        <div className="sm:col-span-2">
          <TextField
            name="amlProgram"
            label="AML / KYC program summary"
            rows={4}
            placeholder="Onboarding KYC, transaction monitoring, recordkeeping, SAR/CTR filing…"
          />
        </div>
        <div className="sm:col-span-2">
          <TextField
            name="sanctionsApproach"
            label="Sanctions screening approach"
            rows={3}
            placeholder="Lists screened (OFAC, UN, EU…), tooling, frequency…"
          />
        </div>
      </Section>

      <Section n={3} title="Operations & settlement">
        <div className="sm:col-span-2">
          <TextField
            name="corridors"
            label="Corridors you want to offer"
            rows={2}
            placeholder="e.g. US→IN, US→PH, GB→NG"
          />
        </div>
        <Field
          name="expectedMonthlyVolumeUsd"
          label="Expected monthly volume (USD)"
          optional
          placeholder="$2,000,000"
        />
        <Field name="avgTransferSize" label="Average transfer size" optional placeholder="$400" />
        <Field
          name="currentMonthlyVolume"
          label="Current monthly volume (if live)"
          optional
        />
        <Field name="settlementBank" label="Settlement bank" optional />
        <Field name="settlementCountry" label="Settlement country" optional />
        <Field
          name="settlementCurrencies"
          label="Settlement currencies"
          optional
          placeholder="USD, INR"
        />
        <div className="sm:col-span-2">
          <TextField
            name="payoutMethods"
            label="Payout methods required"
            rows={2}
            placeholder="Bank deposit, UPI, wallet, cash pickup…"
          />
        </div>
      </Section>

      <Section n={4} title="Technical & contacts">
        <div className="flex flex-col gap-2">
          <label htmlFor="integrationPreference" className={LABEL}>
            Integration preference
          </label>
          <select
            id="integrationPreference"
            name="integrationPreference"
            className={INPUT}
            defaultValue=""
          >
            <option value="">Select… (optional)</option>
            <option value="hosted">Hosted bot + pay page (fastest)</option>
            <option value="api">REST API integration</option>
            <option value="hybrid">Hybrid</option>
            <option value="unsure">Not sure yet</option>
          </select>
        </div>
        <Field
          name="whatsappNumber"
          label="WhatsApp business number"
          optional
          placeholder="+1 555 123 4567"
        />
        <Field name="brandName" label="Brand name for the bot" optional />
        <Field name="primaryContact" label="Primary contact (name + email)" required />
        <Field name="complianceContact" label="Compliance contact" optional />
        <Field name="technicalContact" label="Technical contact" optional />
        <div className="sm:col-span-2">
          <TextField name="notes" label="Anything else?" rows={3} />
        </div>
      </Section>

      {/* Document uploads — all optional. */}
      <fieldset className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 sm:p-7">
        <legend className="px-2 text-[15px] font-bold text-[#25d366]">Documents</legend>
        <p className="mt-1 mb-4 text-[13.5px] text-[#8b94a0]">
          Optional. PDF, PNG, or JPEG, up to 4.5&nbsp;MB each. You can submit without these and
          send them later.
        </p>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          {DOC_SLOTS.map((slot) => (
            <div key={slot.id} className="flex flex-col gap-2">
              <label htmlFor={slot.id} className={LABEL}>
                {slot.label}{' '}
                <span className="font-normal text-[#5b6470]">(optional)</span>
              </label>
              <input
                id={slot.id}
                name={slot.id}
                type="file"
                accept={ACCEPT}
                className="block w-full text-[14px] text-[#8b94a0] file:mr-4 file:rounded-full file:border-0 file:bg-[#25d366]/15 file:px-4 file:py-2 file:text-[13px] file:font-semibold file:text-[#25d366] hover:file:bg-[#25d366]/25"
              />
            </div>
          ))}
        </div>
      </fieldset>

      {uploadError && (
        <p
          role="alert"
          className="rounded-xl border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.08)] px-4 py-3 text-[14px] text-[#f4c7c7]"
        >
          {uploadError}
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex min-h-[52px] items-center justify-center rounded-full bg-[#25d366] px-8 text-[16px] font-bold text-[#04231a] transition-[background-color,transform] duration-150 hover:bg-[#1fbd5d] hover:[transform:translateY(-1px)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Submitting…' : 'Submit application'}
        </button>
        <p className="text-[13px] text-[#5b6470]">
          Legal entity name, country of incorporation, and primary contact are required.
        </p>
      </div>
    </form>
  );
}
