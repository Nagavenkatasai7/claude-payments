'use client';

import { useState, type FormEvent } from 'react';
import type { FundingMethod } from '@/lib/types';

type Status = 'idle' | 'paying' | 'done' | 'error';

export function PayForm({
  transferId,
  fundingMethod,
}: {
  transferId: string;
  fundingMethod: FundingMethod;
}) {
  const [status, setStatus] = useState<Status>('idle');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus('paying');
    try {
      const res = await fetch(`/api/pay/${transferId}`, { method: 'POST' });
      setStatus(res.ok ? 'done' : 'error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <p className="done">
        &#x2705; Payment complete! Check WhatsApp for your receipt.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      {fundingMethod === 'bank_transfer' ? (
        <BankForm />
      ) : (
        <CardForm />
      )}
      <button type="submit" disabled={status === 'paying'}>
        {status === 'paying' ? 'Processing…' : 'Pay now'}
      </button>
      {status === 'error' && (
        <p className="err">Something went wrong. Please try again.</p>
      )}
    </form>
  );
}

function CardForm() {
  return (
    <>
      <label>
        Card number
        <input required placeholder="4242 4242 4242 4242" inputMode="numeric" />
      </label>
      <div className="pair">
        <label>
          Expiry
          <input required placeholder="MM/YY" />
        </label>
        <label>
          CVC
          <input required placeholder="123" inputMode="numeric" />
        </label>
      </div>
      <label>
        Name on card
        <input required placeholder="Your name" />
      </label>
    </>
  );
}

function BankForm() {
  return (
    <>
      <label>
        Account holder name
        <input required placeholder="Your full name" />
      </label>
      <label>
        Account number
        <input required placeholder="000123456789" inputMode="numeric" />
      </label>
      <label>
        Routing number
        <input required placeholder="021000021" inputMode="numeric" />
      </label>
    </>
  );
}
