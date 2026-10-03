import { notFound } from 'next/navigation';
import { requirePartnerStaff } from '@/lib/auth';
import { PARTNER_ROUTES } from '../../../routes';

// PLACEHOLDER (lost-features restore, foundation commit). The route is registered in routes.ts so
// the parallel builds share one table. The real page (an admin can create a customer by hand (A5))
// replaces this file in the same PR. Until then it gates like the real page and answers 404.
export default async function Page(): Promise<never> {
  await requirePartnerStaff(PARTNER_ROUTES.customersNew.policy);
  notFound();
}
