'use client';

import { useState, type FormEvent } from 'react';

type Status = 'idle' | 'paying' | 'done' | 'error';

export function PayForm({ transferId }: { transferId: string }) {
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
        ✅ Payment complete! Check WhatsApp for your receipt.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
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
      <button type="submit" disabled={status === 'paying'}>
        {status === 'paying' ? 'Processing…' : 'Pay now'}
      </button>
      {status === 'error' && (
        <p className="err">Something went wrong. Please try again.</p>
      )}
    </form>
  );
}
