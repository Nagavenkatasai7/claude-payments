import { describe, it, expect } from 'vitest';
import { COMPANY, COMPANY_ADDRESS, COMPANY_NAME_AND_ADDRESS, companyFooterLine } from '@/lib/company';

// Owner, 2026-10-11: SR Technosolutions Inc and its address go on the privacy notice and the other
// legal pages, from one source.
describe('src/lib/company.ts', () => {
  it('holds the entity and address exactly as the owner gave them', () => {
    expect(COMPANY.legalName).toBe('SR Technosolutions Inc');
    expect(COMPANY_ADDRESS).toBe('16514 NW 3rd St, Pembroke Pines, FL 33028, USA');
    expect(COMPANY_NAME_AND_ADDRESS).toBe('SR Technosolutions Inc, 16514 NW 3rd St, Pembroke Pines, FL 33028, USA');
  });

  it('builds the footer line for the given year', () => {
    expect(companyFooterLine(2026)).toBe('© 2026 SR Technosolutions Inc. 16514 NW 3rd St, Pembroke Pines, FL 33028, USA.');
  });
});
