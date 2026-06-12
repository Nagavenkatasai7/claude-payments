'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

// The customer dashboard AI assistant (B5) — WhatsApp-dark idiom, matching the
// /account siblings. Replies come from /api/account/chat (self-gated); any URL
// in a reply is code-generated server-side (the agent strips model URLs), so
// rendering it as a tappable link is safe by construction.

interface Message {
  role: 'user' | 'assistant';
  text: string;
}

/** Render reply text with code-generated URLs as tappable links. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all font-semibold text-[#53bdeb] underline"
          >
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="Assistant is typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8696a0]"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

export function ChatClient() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pending]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  async function send() {
    const text = input.trim();
    if (!text || pending) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text }]);
    setPending(true);
    // On failure: drop the optimistic bubble (it was never received) and put
    // the text back in the input so the customer never retypes a message.
    function failTurn(notice: string) {
      setMessages((m) => m.slice(0, -1));
      setInput((cur) => cur || text);
      setToast(notice);
    }
    try {
      const res = await fetch('/api/account/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const data = (await res.json().catch(() => null)) as
        | { reply?: string; error?: string }
        | null;
      if (!res.ok || typeof data?.reply !== 'string') {
        failTurn(data?.error ?? 'Something went wrong — please try again.');
        return;
      }
      setMessages((m) => [...m, { role: 'assistant', text: data.reply! }]);
    } catch {
      failTurn('Could not reach the assistant — check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 text-[#e9edef] [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
      <div className="flex w-full max-w-[420px] flex-col rounded-2xl bg-[#111b21] p-7">
        <div className="mb-1 text-xl font-extrabold leading-normal text-[#25d366]">SmartRemit</div>
        <h1 className="mb-3 text-lg font-semibold leading-normal">Chat with us</h1>

        {/* Persistent disclaimer banner */}
        <p className="mb-4 rounded-xl border border-[#2a3942] bg-[#1b2a31] px-3.5 py-2.5 text-[12px] leading-normal text-[#8696a0]">
          AI assistant — answers can be wrong. Money only ever moves through your approved pay
          page.
        </p>

        <div className="mb-4 flex min-h-[300px] flex-1 flex-col gap-2 overflow-y-auto">
          {messages.length === 0 ? (
            <p className="text-sm leading-normal text-[#8696a0]">
              Ask about your transfers, limits, saved recipients, refunds — or repeat a past
              send.
            </p>
          ) : null}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3.5 py-2 text-sm leading-normal ${
                m.role === 'user'
                  ? 'self-end rounded-br-sm bg-[#005c4b]'
                  : 'self-start rounded-bl-sm bg-[#202c33]'
              }`}
            >
              {m.role === 'assistant' ? <Linkified text={m.text} /> : m.text}
            </div>
          ))}
          {pending ? (
            <div className="max-w-[85%] self-start rounded-xl rounded-bl-sm bg-[#202c33] px-3.5 py-2">
              <TypingDots />
            </div>
          ) : null}
          <div ref={endRef} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={1000}
            placeholder="Type a message"
            aria-label="Message"
            className="min-w-0 flex-1 rounded-3xl border border-[#2a3942] bg-[#202c33] px-4 py-2.5 text-[15px] text-[#e9edef] placeholder-[#8696a0] outline-none focus:border-[#25d366]"
          />
          <button
            type="submit"
            disabled={pending || input.trim().length === 0}
            className="cursor-pointer rounded-3xl bg-[#25d366] px-5 py-2.5 text-[15px] font-bold text-[#111b21] disabled:cursor-default disabled:opacity-50"
          >
            Send
          </button>
        </form>

        <p className="mt-4">
          <Link href="/account" className="text-sm text-[#8696a0] underline">
            ← Back to your account
          </Link>
        </p>
      </div>

      {toast ? (
        <div
          role="alert"
          className="fixed bottom-6 left-1/2 w-[90%] max-w-[380px] -translate-x-1/2 rounded-xl border border-[#2a3942] bg-[#202c33] px-4 py-3 text-center text-sm leading-normal text-[#e9edef] shadow-lg"
        >
          {toast}
        </div>
      ) : null}
    </main>
  );
}
