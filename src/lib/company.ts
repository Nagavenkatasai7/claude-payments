// company — the legal entity behind SmartRemit, in ONE place (owner, 2026-10-11).
//
// Every page that names the company (legal drafts, site footers, the portal footer and its
// Contact page) reads it from here, so a change of address is a one-line edit. PURE: no env, no
// I/O, safe in server and client components. These are the company's public business details, not
// customer data.

export const COMPANY = {
  legalName: 'SR Technosolutions Inc',
  street: '16514 NW 3rd St',
  city: 'Pembroke Pines',
  region: 'FL',
  postalCode: '33028',
  country: 'USA',
  supportEmail: 'support@smartremit.ai',
} as const;

/** "16514 NW 3rd St, Pembroke Pines, FL 33028, USA" */
export const COMPANY_ADDRESS = `${COMPANY.street}, ${COMPANY.city}, ${COMPANY.region} ${COMPANY.postalCode}, ${COMPANY.country}`;

/** "SR Technosolutions Inc, 16514 NW 3rd St, Pembroke Pines, FL 33028, USA" */
export const COMPANY_NAME_AND_ADDRESS = `${COMPANY.legalName}, ${COMPANY_ADDRESS}`;

/** The footer line every SmartRemit page shows. `year` is passed in so the helper stays pure. */
export function companyFooterLine(year: number): string {
  return `© ${year} ${COMPANY.legalName}. ${COMPANY_ADDRESS}.`;
}

/** The apex site, for links from a partner subdomain (the legal pages live only on the apex). */
export const APEX_URL = 'https://smartremit.ai';
