// The security points the /trust page publishes. Each one is true of the running code today;
// the comment next to it names where. Keep claims no wider than the code.

export interface SecurityPoint {
  title: string;
  body: string;
}

export const SECURITY_POINTS: readonly SecurityPoint[] = [
  // Architecture: SmartRemit orchestrates; licensed partners move the money.
  {
    title: 'Non-custodial',
    body: 'SmartRemit never holds, receives or disburses customer funds. Licensed partners settle on their own rails.',
  },
  // next.config.ts security headers (Strict-Transport-Security).
  { title: 'Encryption in transit', body: 'HTTPS only, with HTTP Strict Transport Security.' },
  // src/lib/field-crypto.ts (envelope AES-256-GCM). Deliberately not "all data".
  {
    title: 'Field-level encryption',
    body: 'Payout account details, identity-verification data and integration credentials are encrypted at the field level in our database (AES-256-GCM). A transfer draft waiting for payment keeps an unencrypted copy in the short-lived cache for up to 30 minutes.',
  },
  // Outbound instructions are signed; inbound callbacks are verified fail-closed with a freshness window.
  {
    title: 'Signed webhooks',
    body: 'Settlement instructions we send are signed with timestamped HMAC-SHA256, and status callbacks we receive are rejected when unsigned, mis-signed or stale.',
  },
  // src/lib/csp.ts (enforced, frame-ancestors 'none') and the X-Frame-Options header.
  { title: 'Browser protections', body: 'An enforced Content-Security-Policy, and our pages cannot be framed.' },
  // Partner-facing queries take the partner id; records a partner does not own read as not found.
  {
    title: 'Tenant isolation',
    body: 'Every partner-facing query is scoped to the partner; records you do not own are reported as not found.',
  },
  // audit_events: identity-page views and staff reveals are recorded.
  {
    title: 'Access to personal data is audited',
    body: 'Staff views and reveals of customer identity data are written to an audit trail.',
  },
  // Screening is structurally untoggleable; production currently screens against a reference list.
  {
    title: 'Sanctions screening',
    body: 'Screening runs on every transfer and cannot be switched off. It currently checks a reference list; connecting a full government sanctions list is planned.',
  },
  // src/lib/ip-rate-limit.ts (selected public endpoints) and src/lib/partner-rate-limit.ts.
  {
    title: 'Rate limiting',
    body: 'Key public endpoints are rate limited per address, and the Partner API per partner and per key.',
  },
  // src/lib/staff-mfa-*: available to staff; not stated as mandatory.
  { title: 'Staff sign-in', body: 'Staff accounts support multi-factor authentication.' },
];
