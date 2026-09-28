import { privacyMetadata, RequestStep } from '../request-step';

// Neutral metadata unless the page can actually render (a portal site AND the flag on).
export const generateMetadata = () => privacyMetadata('portal.privacy.exportTitle');

/** Step 1 of a "export" data request (UI redesign M2-13): gated in RequestStep (host, flag, step-up). */
export default async function ExportRequestPage() {
  return RequestStep({ kind: 'export' });
}
