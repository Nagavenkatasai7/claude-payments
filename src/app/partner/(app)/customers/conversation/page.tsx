import { redirect } from 'next/navigation';
import { requirePartnerStaff } from '@/lib/auth';
import { PARTNER_ROUTES } from '../../../routes';

// Lost-features A8: the conversation log lives at /partner/customers/conversation/<ref>. The bare
// path names no customer, so it gates like the log and sends the admin back to Customers.
export default async function Page(): Promise<never> {
  await requirePartnerStaff(PARTNER_ROUTES.customerConversation.policy);
  redirect(PARTNER_ROUTES.customers.href);
}
