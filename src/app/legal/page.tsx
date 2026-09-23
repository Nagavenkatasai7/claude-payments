import type { Metadata } from 'next';
import { SMARTREMIT_ICONS } from '../brand-icons';
import { LegalDraftSections, LegalPageShell } from './legal-document';
import {
  LICENSING_DRAFT,
  REMITTANCE_RIGHTS_DRAFT,
  SCHEDULED_TRANSFERS_DRAFT,
  type LegalDraft,
} from '@/lib/legal/drafts';

// /legal — Program-Fix 15 PR A. Licensing (the licensed partner named on the
// receipt is the provider of record; SmartRemit is the technology provider),
// the A-37-style remittance transfer rights, and the §1005.36 scheduled-transfer
// note. DRAFTS for counsel review; the text lives in src/lib/legal/drafts.ts.
// The pay page and receipt (PR B) link to #remittance-rights: keep that anchor.

export const metadata: Metadata = {
  title: 'Legal and licensing (draft) — SmartRemit',
  description: 'Who is licensed to move your money, and your remittance transfer rights.',
  icons: SMARTREMIT_ICONS,
};

const DOCS: readonly LegalDraft[] = [LICENSING_DRAFT, REMITTANCE_RIGHTS_DRAFT, SCHEDULED_TRANSFERS_DRAFT];

export default function LegalPage() {
  return (
    <LegalPageShell
      current="/legal"
      title="Legal and licensing"
      summary="Who is licensed to move your money, what SmartRemit does, and your rights when you send money abroad."
    >
      <nav aria-label="On this page" className="mb-10 text-sm">
        <ul className="flex flex-wrap gap-x-5 gap-y-2">
          {DOCS.map((d) => (
            <li key={d.id}>
              <a href={`#${d.id}`} className="text-primary underline-offset-4 hover:underline">
                {d.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="space-y-14">
        {DOCS.map((d) => (
          <section key={d.id} id={d.id} aria-labelledby={`${d.id}-h`} className="scroll-mt-6">
            <h2 id={`${d.id}-h`} className="text-2xl font-semibold tracking-tight">
              {d.title}
            </h2>
            <p className="mt-2 mb-6 text-muted-foreground">{d.summary}</p>
            <LegalDraftSections draft={d} headingLevel="h3" />
          </section>
        ))}
      </div>
    </LegalPageShell>
  );
}
