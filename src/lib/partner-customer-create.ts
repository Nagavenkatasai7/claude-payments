import { isValidPhone, normalizePhone } from './phone';
import { countryForPhone } from './partner-currency';
import { boundReason, STAFF_REASON_MAX, STAFF_REASON_MIN } from './send-limits';
import { isPartnerNoteShaped } from './partner-transfers';
import type { CountryCode, Customer, KycMode, PartnerId } from './types';
import type { MessageKey } from './i18n';

// partner-customer-create: the PURE parse and row build behind /partner/customers/new (lost-features
// p2 A5). A partner admin creates a customer by hand: a phone, an optional legal name, a country the
// partner serves and a KYC status. Only `not_started` is open to every partner; `verified` is a KYC
// decision, so it is accepted only when the partner runs KYC itself (delegated mode) and with a reason.
// `grandfathered` is never offered to partners. The row implies no WhatsApp consent (no optInAt).

/** The longest legal name accepted (whitespace collapsed first). */
export const MANUAL_NAME_MAX = 120;

export type ManualKycStatus = 'not_started' | 'verified';

export interface ManualCustomerOwner {
  countries: readonly CountryCode[];
  kycMode: KycMode;
}

export type ParsedManualCustomer = {
  ok: true;
  phone: string;
  senderCountry: CountryCode;
  fullName?: string;
  kycStatus: ManualKycStatus;
  reason?: string;
};

export type ManualCustomerError =
  | 'partner.customers.create.invalidPhone'
  | 'partner.customers.create.invalidCountry'
  | 'partner.customers.create.invalidName'
  | 'partner.customers.create.invalidStatus'
  | 'partner.customers.create.verifiedNotAllowed'
  | 'partner.customers.create.reasonTooShort'
  | 'partner.customers.create.reasonHasNumber';

export type ManualCustomerParse = ParsedManualCustomer | { ok: false; errorKey: ManualCustomerError & MessageKey };

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

export function parseManualCustomer(form: FormData, owner: ManualCustomerOwner): ManualCustomerParse {
  const phone = normalizePhone(field(form, 'phone').slice(0, 40));
  if (!isValidPhone(phone)) return { ok: false, errorKey: 'partner.customers.create.invalidPhone' };

  // The posted country must be one the partner serves, exactly as the select offers it; with none
  // posted, the phone's calling code decides, again only when the partner serves that country.
  const posted = field(form, 'country').trim();
  const candidate = posted !== '' ? posted : countryForPhone(phone);
  const senderCountry = owner.countries.find((c) => c === candidate);
  if (!senderCountry) return { ok: false, errorKey: 'partner.customers.create.invalidCountry' };

  const name = field(form, 'fullName').replace(/\s+/g, ' ').trim();
  if ([...name].length > MANUAL_NAME_MAX || !isPartnerNoteShaped(name)) {
    return { ok: false, errorKey: 'partner.customers.create.invalidName' };
  }

  const status = field(form, 'kycStatus');
  if (status === '' || status === 'not_started') {
    return { ok: true, phone, senderCountry, ...(name ? { fullName: name } : {}), kycStatus: 'not_started' };
  }
  if (status !== 'verified') return { ok: false, errorKey: 'partner.customers.create.invalidStatus' };
  if (owner.kycMode !== 'delegated') return { ok: false, errorKey: 'partner.customers.create.verifiedNotAllowed' };

  // Same bounds as requireStaffReason (send-limits.ts), returned as a key instead of thrown.
  const reason = boundReason(form.get('reason'));
  if (reason.length < STAFF_REASON_MIN) return { ok: false, errorKey: 'partner.customers.create.reasonTooShort' };
  if (!isPartnerNoteShaped(reason)) return { ok: false, errorKey: 'partner.customers.create.reasonHasNumber' };
  return {
    ok: true,
    phone,
    senderCountry,
    ...(name ? { fullName: name } : {}),
    kycStatus: 'verified',
    reason: reason.slice(0, STAFF_REASON_MAX),
  };
}

/** The new row. The tenant comes from the caller (the session), never the form. */
export function freshManualCustomer(parsed: ParsedManualCustomer, partnerId: PartnerId, now: string, reviewer: string): Customer {
  return {
    senderPhone: parsed.phone,
    partnerId,
    senderCountry: parsed.senderCountry,
    kycStatus: parsed.kycStatus,
    ...(parsed.fullName ? { fullName: parsed.fullName } : {}),
    ...(parsed.kycStatus === 'verified' ? { kycVerifiedAt: now, kycApprovedBy: reviewer, kycApprovedAt: now } : {}),
    firstSeenAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
