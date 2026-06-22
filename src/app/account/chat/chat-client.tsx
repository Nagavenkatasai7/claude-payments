'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

// The customer dashboard AI assistant (B5) — clean light dashboard chat, matching
// the /account shell. Replies come from /api/account/chat (self-gated); any URL
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
            className="break-all font-semibold underline"
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
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
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
    <>
      <Card className="overflow-hidden py-0">
        <CardContent className="flex flex-col px-0">
          <div className="flex h-[480px] flex-col gap-3 overflow-y-auto p-4 sm:p-6">
            {messages.length === 0 ? (
              <p className="text-sm leading-normal text-muted-foreground">
                Ask about your transfers, limits, saved recipients, refunds — or repeat a past
                send.
              </p>
            ) : null}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-normal ${
                  m.role === 'user'
                    ? 'self-end rounded-br-sm bg-primary text-primary-foreground'
                    : 'self-start rounded-bl-sm bg-muted text-foreground'
                }`}
              >
                {m.role === 'assistant' ? <Linkified text={m.text} /> : m.text}
              </div>
            ))}
            {pending ? (
              <div className="max-w-[85%] self-start rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5">
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
            className="flex items-center gap-2 border-t border-border p-3 sm:p-4"
          >
            <Input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={1000}
              placeholder="Type a message"
              aria-label="Message"
              className="flex-1"
            />
            <Button type="submit" disabled={pending || input.trim().length === 0}>
              Send
            </Button>
          </form>
        </CardContent>
      </Card>

      {toast ? (
        <div
          role="alert"
          className="fixed bottom-6 left-1/2 w-[90%] max-w-[380px] -translate-x-1/2 rounded-lg border border-border bg-card px-4 py-3 text-center text-sm leading-normal text-card-foreground shadow-lg"
        >
          {toast}
        </div>
      ) : null}
    </>
  );
}
