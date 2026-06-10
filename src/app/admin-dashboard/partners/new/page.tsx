export const dynamic = 'force-dynamic';

import { requirePlatformAdmin } from '@/lib/auth';
import { Sidebar } from '../../sidebar';
import { PartnerSetupWizard } from './wizard';

// Stage 5c: partner onboarding is a WIZARD — identity → brand → KYC →
// WhatsApp → settlement → review. Nothing persists until the final commit
// (one server action: partner + integrations + first API key), and the done
// screen is the go-live checklist with every URL/credential the partner needs.

export default async function NewPartnerPage() {
  await requirePlatformAdmin(); // tenant creation is platform governance

  return (
    <>
      <Sidebar active="partners" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">New partner</div>
            <div className="sh-page-sub">
              Six steps, one commit — abandoning the wizard leaves nothing behind
            </div>
          </div>
        </div>
        <div className="max-w-2xl">
          <PartnerSetupWizard />
        </div>
      </main>
    </>
  );
}
