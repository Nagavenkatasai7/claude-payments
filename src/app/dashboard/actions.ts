'use server';

import { revalidatePath } from 'next/cache';
import { getStore } from '@/lib/store';
import { sendText } from '@/lib/whatsapp';
import {
  cancelTransfer,
  assignTransfer,
  resendPaymentLink,
} from '@/lib/dashboard-ops';

export async function cancelTransferAction(formData: FormData): Promise<void> {
  const id = formData.get('id') as string;
  await cancelTransfer(getStore(), id);
  revalidatePath('/dashboard');
}

export async function assignTransferAction(formData: FormData): Promise<void> {
  const id = formData.get('id') as string;
  const assignee = (formData.get('assignee') as string) ?? '';
  const note = (formData.get('note') as string) ?? '';
  await assignTransfer(getStore(), id, assignee, note);
  revalidatePath('/dashboard');
}

export async function resendPaymentLinkAction(
  formData: FormData,
): Promise<void> {
  const id = formData.get('id') as string;
  await resendPaymentLink(getStore(), sendText, id);
  revalidatePath('/dashboard');
}
