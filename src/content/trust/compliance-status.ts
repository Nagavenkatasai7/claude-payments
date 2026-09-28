// The honest compliance status the /trust page publishes. Change a row only when the underlying
// control is actually attested or certified; never write "compliant" or "certified" before that
// (tests/trust-content.test.ts pins the wording). Compliance owns later edits of this file.

export interface ComplianceRow {
  framework: string;
  status: string;
}

export const COMPLIANCE_STATUS: readonly ComplianceRow[] = [
  {
    framework: 'SOC 2',
    status: 'We have not undergone a SOC 2 examination. Our controls are being aligned to the AICPA Trust Services Criteria.',
  },
  { framework: 'ISO/IEC 27001:2022', status: 'We are not ISO 27001 certified.' },
  {
    framework: 'UK GDPR / EU GDPR',
    // A data-processing agreement is not written yet, so the page does not say we sign one.
    status: 'We act as our partners’ processor for customer data. A data-processing agreement is in preparation.',
  },
  {
    framework: 'PCI DSS',
    status: 'SmartRemit does not store, process or transmit cardholder data. Card funding is not enabled.',
  },
  { framework: 'GLBA Safeguards Rule', status: 'We support partners’ Safeguards Rule programs as a service provider.' },
  { framework: 'India DPDP Act 2023', status: 'We are tracking DPDP Rules commencement (May 2027).' },
  { framework: 'HIPAA', status: 'HIPAA does not apply to our service.' },
];

/** Month granularity (YYYY-MM). Update it whenever a row changes. */
export const COMPLIANCE_AS_OF = '2026-09';
