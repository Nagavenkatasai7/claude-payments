import type { Metadata } from 'next';
import { SMARTREMIT_ICONS } from '../brand-icons';
import { LegalDraftSections, LegalPageShell } from '../legal/legal-document';
import { PRIVACY_DRAFT } from '@/lib/legal/drafts';

// /privacy — Program-Fix 15 PR A. A DRAFT for counsel review (GLBA-style notice
// plus a WhatsApp data section); the text lives in src/lib/legal/drafts.ts.
// Public (src/middleware.ts gates only /account and /admin-dashboard).

export const metadata: Metadata = {
  title: 'Privacy Notice (draft) — SmartRemit',
  description: PRIVACY_DRAFT.summary,
  icons: SMARTREMIT_ICONS,
};

export default function PrivacyPage() {
  return (
    <LegalPageShell current="/privacy" title={PRIVACY_DRAFT.title} summary={PRIVACY_DRAFT.summary}>
      <LegalDraftSections draft={PRIVACY_DRAFT} headingLevel="h2" />
    </LegalPageShell>
  );
}
