export const dynamic = 'force-dynamic';

import { requirePlatformAdmin } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { isPartnerRequestId } from '@/lib/partner-application-decision';
import { partnerTypeLabel } from '@/lib/partner-type';
import { Sidebar } from '../../sidebar';
import { PartnerSetupWizard, type WizardSourceRequest } from './wizard';

// Stage 5c: partner onboarding is a WIZARD — identity → brand → KYC →
// WhatsApp → settlement → review. Nothing persists until the final commit
// (one server action: partner + integrations + first API key), and the done
// screen is the go-live checklist with every URL/credential the partner needs.

export default async function NewPartnerPage({
  searchParams,
}: {
  searchParams?: Promise<{ fromRequest?: string }>;
}) {
  await requirePlatformAdmin(); // tenant creation is platform governance

  // Program-Fix 49C: "Set up this partner" from an APPROVED partner request
  // pre-fills the wizard. A malformed, unknown or undecided id is ignored (the
  // wizard starts empty) — the param is a convenience, never an authority.
  const fromId = String((await searchParams)?.fromRequest ?? '');
  let fromRequest: WizardSourceRequest | undefined;
  if (isPartnerRequestId(fromId)) {
    const req = await getStore().getPartnerRequest(fromId);
    if (req && req.applicationStatus === 'approved') {
      fromRequest = {
        id: req.id,
        companyName: req.companyName,
        corridors: req.corridors,
        ...(req.partnerType ? { partnerTypeLabel: partnerTypeLabel(req.partnerType) } : {}),
      };
    }
  }

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
          <PartnerSetupWizard fromRequest={fromRequest} />
        </div>
      </main>
    </>
  );
}
