import type { Metadata } from 'next';
import { SMARTREMIT_ICONS } from '../brand-icons';
import { LegalDraftSections, LegalPageShell } from '../legal/legal-document';
import { TERMS_DRAFT } from '@/lib/legal/drafts';

// /terms — Program-Fix 15 PR A. A DRAFT for counsel review; the text lives in
// src/lib/legal/drafts.ts. Public (src/proxy.ts gates only /account and
// /admin-dashboard).

export const metadata: Metadata = {
  title: 'Terms of Service (draft) — SmartRemit',
  description: TERMS_DRAFT.summary,
  icons: SMARTREMIT_ICONS,
};

export default function TermsPage() {
  return (
    <LegalPageShell current="/terms" title={TERMS_DRAFT.title} summary={TERMS_DRAFT.summary}>
      <LegalDraftSections draft={TERMS_DRAFT} headingLevel="h2" />
    </LegalPageShell>
  );
}
