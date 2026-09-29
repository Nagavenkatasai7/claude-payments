import { privacyMetadata, RequestStep } from '../request-step';

// Neutral metadata unless the page can actually render (a portal site AND the flag on).
export const generateMetadata = () => privacyMetadata('portal.privacy.deleteTitle');

/** Step 1 of a "delete" data request (UI redesign M2-13): gated in RequestStep (host, flag, step-up). */
export default async function DeleteRequestPage() {
  return RequestStep({ kind: 'delete' });
}
