# SendHome WhatsApp Remittance Prototype — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a WhatsApp bot prototype that lets a US user send (mocked) money to family in India through a natural AI conversation.

**Architecture:** Next.js App Router app on Vercel. A webhook receives WhatsApp messages, an AI agent (Kimi K2.6 via Ollama Cloud) drives the conversation and calls TypeScript tools for deterministic money logic, conversation/transfer state lives in Upstash Redis, and a mock card page triggers WhatsApp delivery confirmations.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, `@upstash/redis`, Meta WhatsApp Cloud API, Ollama Cloud (OpenAI-compatible API).

Reference spec: `docs/superpowers/specs/2026-05-21-whatsapp-india-remittance-design.md`

---

## File Structure

```
package.json, tsconfig.json, next.config.ts, vitest.config.ts
.gitignore, .env.example, README.md
tests/setup.ts            - dummy env vars for tests
tests/helpers.ts          - in-memory fake Redis for tests
src/lib/types.ts          - shared TypeScript types
src/lib/env.ts            - environment variable access
src/lib/id.ts             - transfer id generator
src/lib/fx.ts             - mock FX rate + fee math
src/lib/store.ts          - Upstash Redis access layer
src/lib/tools.ts          - agent tool schemas + executors
src/lib/prompt.ts         - system prompt
src/lib/ollama.ts         - Ollama Cloud chat client
src/lib/agent.ts          - agent tool-call loop
src/lib/whatsapp.ts       - Meta Cloud API client + payload parsing
src/lib/payment.ts        - mock payment completion logic
src/app/layout.tsx        - root layout
src/app/globals.css       - styling
src/app/page.tsx          - landing page
src/app/api/whatsapp/route.ts        - WhatsApp webhook (GET verify, POST receive)
src/app/api/pay/[transferId]/route.ts - mock payment submit handler
src/app/pay/[transferId]/page.tsx     - mock card payment page
src/app/pay/[transferId]/pay-form.tsx - client card form
```

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`
- Create: `.gitignore`, `tests/setup.ts`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "sendhome",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest"
  },
  "dependencies": {
    "next": "^16.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@upstash/redis": "^1.34.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `next.config.ts`**

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {};

export default nextConfig;
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules
.next
.env
.env.local
*.tsbuildinfo
next-env.d.ts
coverage
```

- [ ] **Step 6: Create `tests/setup.ts`**

```ts
process.env.OLLAMA_BASE_URL ||= 'https://ollama.test/v1';
process.env.OLLAMA_API_KEY ||= 'test-key';
process.env.OLLAMA_MODEL ||= 'kimi-test';
process.env.WHATSAPP_TOKEN ||= 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID ||= '123456';
process.env.WHATSAPP_VERIFY_TOKEN ||= 'verify-test';
process.env.APP_BASE_URL ||= 'https://sendhome.test';
process.env.KV_REST_API_URL ||= 'https://kv.test';
process.env.KV_REST_API_TOKEN ||= 'kv-token';
```

- [ ] **Step 7: Create `src/app/globals.css`**

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0b141a;
  color: #e9edef;
  display: flex;
  justify-content: center;
  padding: 32px 16px;
  min-height: 100vh;
}
.card {
  background: #111b21;
  border-radius: 16px;
  padding: 28px;
  max-width: 420px;
  width: 100%;
}
.brand { color: #25d366; font-weight: 800; font-size: 20px; margin-bottom: 4px; }
h1 { font-size: 18px; margin-bottom: 20px; font-weight: 600; }
.summary { background: #202c33; border-radius: 12px; padding: 14px; margin-bottom: 20px; }
.row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; }
.row span:first-child { color: #8696a0; }
form label { display: block; font-size: 13px; color: #8696a0; margin-bottom: 12px; }
form input {
  width: 100%; margin-top: 4px; padding: 10px;
  background: #2a3942; border: 1px solid #2a3942; border-radius: 8px;
  color: #e9edef; font-size: 15px;
}
.pair { display: flex; gap: 12px; }
.pair label { flex: 1; }
button {
  width: 100%; padding: 12px; background: #25d366; color: #0b141a;
  border: none; border-radius: 24px; font-size: 15px; font-weight: 700;
  cursor: pointer;
}
button:disabled { opacity: 0.6; cursor: default; }
.done { color: #25d366; font-weight: 600; text-align: center; }
.err { color: #f15c6d; font-size: 13px; margin-top: 8px; }
```

- [ ] **Step 8: Create `src/app/layout.tsx`**

```tsx
import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'SendHome',
  description: 'Send money to family in India via WhatsApp',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 9: Create `src/app/page.tsx`**

```tsx
export default function Home() {
  return (
    <main className="card">
      <div className="brand">SendHome</div>
      <h1>Send money to India, right inside WhatsApp.</h1>
      <p style={{ color: '#8696a0', fontSize: 14, lineHeight: 1.6 }}>
        This is a prototype. Message our WhatsApp number to start a transfer —
        an AI assistant guides you in English, Hindi, or Hinglish.
      </p>
    </main>
  );
}
```

- [ ] **Step 10: Install dependencies and verify the build**

Run: `npm install`
Then run: `npm run build`
Expected: build completes successfully, no type errors. A `next-env.d.ts` file is generated.

- [ ] **Step 11: Verify the test runner works**

Run: `npm test`
Expected: PASS — "No test files found" but exits 0 due to `--passWithNoTests`.

- [ ] **Step 12: Commit**

```bash
git add package.json tsconfig.json next.config.ts vitest.config.ts .gitignore tests/setup.ts src/app
git commit -m "chore: scaffold Next.js + Vitest project"
```

---

## Task 2: Shared types

**Files:**
- Create: `src/lib/types.ts`

This task defines types only — no test (types are checked by `tsc` during later builds).

- [ ] **Step 1: Create `src/lib/types.ts`**

```ts
export type PayoutMethod = 'upi' | 'bank';

export type TransferStatus = 'awaiting_payment' | 'paid' | 'delivered';

export interface Quote {
  amountUsd: number;
  feeUsd: number;
  totalChargeUsd: number;
  fxRate: number;
  amountInr: number;
  deliveryEstimate: string;
}

export interface Transfer {
  id: string;
  phone: string;
  amountUsd: number;
  feeUsd: number;
  totalChargeUsd: number;
  fxRate: number;
  amountInr: number;
  recipientName: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  status: TransferStatus;
  createdAt: string;
  paidAt?: string;
  deliveredAt?: string;
}

export interface UserRecord {
  transferCount: number;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add shared TypeScript types"
```

---

## Task 3: Environment config + id helper

**Files:**
- Create: `src/lib/env.ts`, `src/lib/id.ts`
- Test: `tests/env.test.ts`, `tests/id.test.ts`

- [ ] **Step 1: Write the failing test `tests/env.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { env } from '@/lib/env';

describe('env', () => {
  it('reads a configured variable', () => {
    expect(env.appBaseUrl).toBe('https://sendhome.test');
  });

  it('throws a clear error when a variable is missing', () => {
    const original = process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    expect(() => env.ollamaApiKey).toThrow(/OLLAMA_API_KEY/);
    process.env.OLLAMA_API_KEY = original;
  });
});
```

- [ ] **Step 2: Write the failing test `tests/id.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { newTransferId } from '@/lib/id';

describe('newTransferId', () => {
  it('returns an 8-character alphanumeric id', () => {
    const id = newTransferId();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
  });

  it('returns different ids on repeated calls', () => {
    expect(newTransferId()).not.toBe(newTransferId());
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve `@/lib/env` and `@/lib/id`.

- [ ] **Step 4: Create `src/lib/env.ts`**

```ts
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  get ollamaBaseUrl() {
    return required('OLLAMA_BASE_URL');
  },
  get ollamaApiKey() {
    return required('OLLAMA_API_KEY');
  },
  get ollamaModel() {
    return required('OLLAMA_MODEL');
  },
  get whatsappToken() {
    return required('WHATSAPP_TOKEN');
  },
  get whatsappPhoneNumberId() {
    return required('WHATSAPP_PHONE_NUMBER_ID');
  },
  get whatsappVerifyToken() {
    return required('WHATSAPP_VERIFY_TOKEN');
  },
  get appBaseUrl() {
    return required('APP_BASE_URL');
  },
  get kvUrl() {
    return required('KV_REST_API_URL');
  },
  get kvToken() {
    return required('KV_REST_API_TOKEN');
  },
};
```

- [ ] **Step 5: Create `src/lib/id.ts`**

```ts
export function newTransferId(): string {
  let id = '';
  while (id.length < 8) {
    id += Math.random().toString(36).slice(2);
  }
  return id.slice(0, 8);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — `env.test.ts` and `id.test.ts` pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/env.ts src/lib/id.ts tests/env.test.ts tests/id.test.ts
git commit -m "feat: add env config and transfer id helper"
```

---

## Task 4: FX rate and fee module

**Files:**
- Create: `src/lib/fx.ts`
- Test: `tests/fx.test.ts`

- [ ] **Step 1: Write the failing test `tests/fx.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { quote, QuoteError, FX_RATE, REPEAT_FEE_USD } from '@/lib/fx';

describe('quote', () => {
  it('charges no fee on the first transfer', () => {
    const q = quote(500, 'upi', 0);
    expect(q.feeUsd).toBe(0);
    expect(q.totalChargeUsd).toBe(500);
  });

  it('charges the repeat fee on later transfers', () => {
    const q = quote(500, 'upi', 1);
    expect(q.feeUsd).toBe(REPEAT_FEE_USD);
    expect(q.totalChargeUsd).toBe(502.99);
  });

  it('converts USD to INR at the fixed rate, rounded', () => {
    const q = quote(100, 'upi', 0);
    expect(q.fxRate).toBe(FX_RATE);
    expect(q.amountInr).toBe(Math.round(100 * FX_RATE));
  });

  it('gives a faster delivery estimate for UPI than bank', () => {
    expect(quote(100, 'upi', 0).deliveryEstimate).toMatch(/minute/i);
    expect(quote(100, 'bank', 0).deliveryEstimate).toMatch(/hour/i);
  });

  it('rejects amounts below the minimum', () => {
    expect(() => quote(5, 'upi', 0)).toThrow(QuoteError);
  });

  it('rejects amounts above the maximum', () => {
    expect(() => quote(5000, 'upi', 0)).toThrow(QuoteError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `@/lib/fx`.

- [ ] **Step 3: Create `src/lib/fx.ts`**

```ts
import type { PayoutMethod, Quote } from './types';

export const FX_RATE = 85.2;
export const REPEAT_FEE_USD = 2.99;
export const MIN_USD = 10;
export const MAX_USD = 2999;

export class QuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteError';
  }
}

export function quote(
  amountUsd: number,
  payoutMethod: PayoutMethod,
  transferCount: number,
): Quote {
  if (!Number.isFinite(amountUsd)) {
    throw new QuoteError('Please give a valid amount in US dollars.');
  }
  if (amountUsd < MIN_USD || amountUsd > MAX_USD) {
    throw new QuoteError(
      `Transfers must be between $${MIN_USD} and $${MAX_USD}.`,
    );
  }
  const feeUsd = transferCount === 0 ? 0 : REPEAT_FEE_USD;
  const amountInr = Math.round(amountUsd * FX_RATE);
  const totalChargeUsd = Math.round((amountUsd + feeUsd) * 100) / 100;
  const deliveryEstimate =
    payoutMethod === 'upi' ? 'within minutes' : 'within 2 hours';

  return {
    amountUsd,
    feeUsd,
    totalChargeUsd,
    fxRate: FX_RATE,
    amountInr,
    deliveryEstimate,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all `fx.test.ts` cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fx.ts tests/fx.test.ts
git commit -m "feat: add mock FX rate and fee calculation"
```

---

## Task 5: Redis store

**Files:**
- Create: `src/lib/store.ts`, `tests/helpers.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Create the test helper `tests/helpers.ts`**

```ts
import type { RedisLike } from '@/lib/store';

export interface FakeRedis extends RedisLike {
  dump: Map<string, string>;
}

export function fakeRedis(): FakeRedis {
  const map = new Map<string, string>();
  return {
    dump: map,
    async get(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    async set(
      key: string,
      value: string,
      opts?: { ex?: number; nx?: boolean },
    ) {
      if (opts?.nx && map.has(key)) return null;
      map.set(key, value);
      return 'OK';
    },
  };
}
```

- [ ] **Step 2: Write the failing test `tests/store.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import type { Transfer } from '@/lib/types';

function sampleTransfer(): Transfer {
  return {
    id: 'abc12345',
    phone: '15551234567',
    amountUsd: 500,
    feeUsd: 0,
    totalChargeUsd: 500,
    fxRate: 85.2,
    amountInr: 42600,
    recipientName: 'Mom',
    payoutMethod: 'upi',
    payoutDestination: 'mom@upi',
    status: 'awaiting_payment',
    createdAt: '2026-05-21T00:00:00.000Z',
  };
}

describe('store', () => {
  it('round-trips a transfer', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(sampleTransfer());
    const loaded = await store.getTransfer('abc12345');
    expect(loaded?.recipientName).toBe('Mom');
  });

  it('returns null for an unknown transfer', async () => {
    const store = createStore(fakeRedis());
    expect(await store.getTransfer('missing')).toBeNull();
  });

  it('round-trips conversation history', async () => {
    const store = createStore(fakeRedis());
    await store.saveConversation('15551234567', [
      { role: 'user', content: 'hi' },
    ]);
    const conv = await store.getConversation('15551234567');
    expect(conv).toHaveLength(1);
    expect(conv[0].content).toBe('hi');
  });

  it('defaults a new user to zero transfers and increments', async () => {
    const store = createStore(fakeRedis());
    expect((await store.getUser('p')).transferCount).toBe(0);
    await store.incrementTransferCount('p');
    expect((await store.getUser('p')).transferCount).toBe(1);
  });

  it('marks a message seen only once', async () => {
    const store = createStore(fakeRedis());
    expect(await store.markMessageSeen('wamid.1')).toBe(true);
    expect(await store.markMessageSeen('wamid.1')).toBe(false);
  });

  it('trims conversation history to the last 40 messages', async () => {
    const store = createStore(fakeRedis());
    const many = Array.from({ length: 60 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }));
    await store.saveConversation('p', many);
    const conv = await store.getConversation('p');
    expect(conv).toHaveLength(40);
    expect(conv[conv.length - 1].content).toBe('m59');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `@/lib/store`.

- [ ] **Step 4: Create `src/lib/store.ts`**

```ts
import { Redis } from '@upstash/redis';
import { env } from './env';
import type { ChatMessage, Transfer, UserRecord } from './types';

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    opts?: { ex?: number; nx?: boolean },
  ): Promise<unknown>;
}

const MAX_HISTORY = 40;

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_HISTORY) return messages;
  let trimmed = messages.slice(messages.length - MAX_HISTORY);
  while (trimmed.length > 0 && trimmed[0].role !== 'user') {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

export function createStore(redis: RedisLike) {
  return {
    async getConversation(phone: string): Promise<ChatMessage[]> {
      const raw = await redis.get(`conv:${phone}`);
      return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
    },
    async saveConversation(
      phone: string,
      messages: ChatMessage[],
    ): Promise<void> {
      await redis.set(`conv:${phone}`, JSON.stringify(trimHistory(messages)));
    },
    async getTransfer(id: string): Promise<Transfer | null> {
      const raw = await redis.get(`transfer:${id}`);
      return raw ? (JSON.parse(raw) as Transfer) : null;
    },
    async saveTransfer(transfer: Transfer): Promise<void> {
      await redis.set(`transfer:${transfer.id}`, JSON.stringify(transfer));
    },
    async getUser(phone: string): Promise<UserRecord> {
      const raw = await redis.get(`user:${phone}`);
      return raw ? (JSON.parse(raw) as UserRecord) : { transferCount: 0 };
    },
    async incrementTransferCount(phone: string): Promise<void> {
      const user = await this.getUser(phone);
      await redis.set(
        `user:${phone}`,
        JSON.stringify({ transferCount: user.transferCount + 1 }),
      );
    },
    async markMessageSeen(wamid: string): Promise<boolean> {
      const result = await redis.set(`msg:${wamid}`, '1', {
        ex: 600,
        nx: true,
      });
      return result !== null;
    },
  };
}

export type Store = ReturnType<typeof createStore>;

let cached: Store | null = null;

export function getStore(): Store {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createStore(redis as unknown as RedisLike);
  }
  return cached;
}
```

Note: `automaticDeserialization: false` keeps Upstash from JSON-parsing values
on `get`, so the strings we store survive a round trip unchanged.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all `store.test.ts` cases pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/store.ts tests/store.test.ts tests/helpers.ts
git commit -m "feat: add Upstash Redis store layer"
```

---

## Task 6: Agent tools

**Files:**
- Create: `src/lib/tools.ts`
- Test: `tests/tools.test.ts`

- [ ] **Step 1: Write the failing test `tests/tools.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { executeTool, toolSchemas } from '@/lib/tools';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';

const PHONE = '15551234567';

describe('toolSchemas', () => {
  it('exposes all four tools', () => {
    const names = toolSchemas.map((t) => t.function.name).sort();
    expect(names).toEqual([
      'check_payment_status',
      'create_transfer',
      'generate_payment_link',
      'get_quote',
    ]);
  });
});

describe('executeTool', () => {
  it('get_quote returns a free first quote', async () => {
    const store = createStore(fakeRedis());
    const result = await executeTool(
      'get_quote',
      { amount_usd: 500, payout_method: 'upi' },
      { phone: PHONE, store },
    );
    expect(result.fee_usd).toBe(0);
    expect(result.amount_inr).toBe(Math.round(500 * 85.2));
  });

  it('get_quote surfaces a validation error as { error }', async () => {
    const store = createStore(fakeRedis());
    const result = await executeTool(
      'get_quote',
      { amount_usd: 5, payout_method: 'upi' },
      { phone: PHONE, store },
    );
    expect(result.error).toMatch(/between/i);
  });

  it('create_transfer persists a transfer and increments the user count', async () => {
    const store = createStore(fakeRedis());
    const result = await executeTool(
      'create_transfer',
      {
        amount_usd: 500,
        recipient_name: 'Mom',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
      },
      { phone: PHONE, store },
    );
    expect(result.status).toBe('awaiting_payment');
    const saved = await store.getTransfer(result.transfer_id as string);
    expect(saved?.recipientName).toBe('Mom');
    expect((await store.getUser(PHONE)).transferCount).toBe(1);
  });

  it('generate_payment_link builds a URL for an existing transfer', async () => {
    const store = createStore(fakeRedis());
    const created = await executeTool(
      'create_transfer',
      {
        amount_usd: 500,
        recipient_name: 'Mom',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
      },
      { phone: PHONE, store },
    );
    const link = await executeTool(
      'generate_payment_link',
      { transfer_id: created.transfer_id },
      { phone: PHONE, store },
    );
    expect(link.url).toBe(
      `https://sendhome.test/pay/${created.transfer_id}`,
    );
  });

  it('check_payment_status reports a transfer status', async () => {
    const store = createStore(fakeRedis());
    const created = await executeTool(
      'create_transfer',
      {
        amount_usd: 500,
        recipient_name: 'Mom',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
      },
      { phone: PHONE, store },
    );
    const status = await executeTool(
      'check_payment_status',
      { transfer_id: created.transfer_id },
      { phone: PHONE, store },
    );
    expect(status.status).toBe('awaiting_payment');
  });

  it('returns an error for an unknown tool', async () => {
    const store = createStore(fakeRedis());
    const result = await executeTool('nope', {}, { phone: PHONE, store });
    expect(result.error).toMatch(/unknown tool/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `@/lib/tools`.

- [ ] **Step 3: Create `src/lib/tools.ts`**

```ts
import { quote, QuoteError } from './fx';
import { newTransferId } from './id';
import { env } from './env';
import type { ChatTool, PayoutMethod, Transfer } from './types';
import type { Store } from './store';

export const toolSchemas: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_quote',
      description:
        'Calculate the fee, exchange rate, and rupee amount the recipient receives. Call this before confirming any transfer.',
      parameters: {
        type: 'object',
        properties: {
          amount_usd: {
            type: 'number',
            description: 'Amount to send, in US dollars.',
          },
          payout_method: {
            type: 'string',
            enum: ['upi', 'bank'],
            description: "How the recipient is paid: 'upi' or 'bank'.",
          },
        },
        required: ['amount_usd', 'payout_method'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_transfer',
      description:
        'Create the transfer record after the user confirms the quote and provides recipient details.',
      parameters: {
        type: 'object',
        properties: {
          amount_usd: { type: 'number' },
          recipient_name: { type: 'string' },
          payout_method: { type: 'string', enum: ['upi', 'bank'] },
          payout_destination: {
            type: 'string',
            description:
              'The UPI ID, or the bank account number with IFSC code.',
          },
        },
        required: [
          'amount_usd',
          'recipient_name',
          'payout_method',
          'payout_destination',
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_payment_link',
      description:
        'Generate the secure link where the user enters card details to pay.',
      parameters: {
        type: 'object',
        properties: { transfer_id: { type: 'string' } },
        required: ['transfer_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_payment_status',
      description: 'Check the current status of a transfer.',
      parameters: {
        type: 'object',
        properties: { transfer_id: { type: 'string' } },
        required: ['transfer_id'],
      },
    },
  },
];

export interface ToolContext {
  phone: string;
  store: Store;
}

type ToolResult = Record<string, unknown>;

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  switch (name) {
    case 'get_quote':
      return getQuoteTool(args, ctx);
    case 'create_transfer':
      return createTransferTool(args, ctx);
    case 'generate_payment_link':
      return generatePaymentLinkTool(args, ctx);
    case 'check_payment_status':
      return checkPaymentStatusTool(args, ctx);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function getQuoteTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const user = await ctx.store.getUser(ctx.phone);
    const q = quote(
      Number(args.amount_usd),
      args.payout_method as PayoutMethod,
      user.transferCount,
    );
    return {
      amount_usd: q.amountUsd,
      fee_usd: q.feeUsd,
      total_charge_usd: q.totalChargeUsd,
      fx_rate: q.fxRate,
      amount_inr: q.amountInr,
      delivery_estimate: q.deliveryEstimate,
    };
  } catch (err) {
    if (err instanceof QuoteError) return { error: err.message };
    throw err;
  }
}

async function createTransferTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const user = await ctx.store.getUser(ctx.phone);
    const payoutMethod = args.payout_method as PayoutMethod;
    const q = quote(Number(args.amount_usd), payoutMethod, user.transferCount);
    const transfer: Transfer = {
      id: newTransferId(),
      phone: ctx.phone,
      amountUsd: q.amountUsd,
      feeUsd: q.feeUsd,
      totalChargeUsd: q.totalChargeUsd,
      fxRate: q.fxRate,
      amountInr: q.amountInr,
      recipientName: String(args.recipient_name),
      payoutMethod,
      payoutDestination: String(args.payout_destination),
      status: 'awaiting_payment',
      createdAt: new Date().toISOString(),
    };
    await ctx.store.saveTransfer(transfer);
    await ctx.store.incrementTransferCount(ctx.phone);
    return {
      transfer_id: transfer.id,
      status: transfer.status,
      amount_inr: transfer.amountInr,
      total_charge_usd: transfer.totalChargeUsd,
      recipient_name: transfer.recipientName,
    };
  } catch (err) {
    if (err instanceof QuoteError) return { error: err.message };
    throw err;
  }
}

async function generatePaymentLinkTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const transfer = await ctx.store.getTransfer(String(args.transfer_id));
  if (!transfer) return { error: 'Transfer not found.' };
  return { url: `${env.appBaseUrl}/pay/${transfer.id}` };
}

async function checkPaymentStatusTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const transfer = await ctx.store.getTransfer(String(args.transfer_id));
  if (!transfer) return { error: 'Transfer not found.' };
  return { transfer_id: transfer.id, status: transfer.status };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all `tools.test.ts` cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tools.ts tests/tools.test.ts
git commit -m "feat: add agent tool schemas and executors"
```

---

## Task 7: System prompt

**Files:**
- Create: `src/lib/prompt.ts`
- Test: `tests/prompt.test.ts`

- [ ] **Step 1: Write the failing test `tests/prompt.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT } from '@/lib/prompt';

describe('SYSTEM_PROMPT', () => {
  it('names the tools the agent must use', () => {
    expect(SYSTEM_PROMPT).toContain('get_quote');
    expect(SYSTEM_PROMPT).toContain('create_transfer');
    expect(SYSTEM_PROMPT).toContain('generate_payment_link');
  });

  it('forbids asking for card details in chat', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('card');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('never');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `@/lib/prompt`.

- [ ] **Step 3: Create `src/lib/prompt.ts`**

```ts
export const SYSTEM_PROMPT = `You are the assistant for SendHome, a service that lets people in the United States send money to family in India through WhatsApp.

Your job: guide the user through sending money in a warm, brief, WhatsApp-style conversation.

LANGUAGE
- Mirror the user's language and register. Reply in English, Hindi, or Hinglish to match them.
- Keep messages short. Use emojis sparingly.

WHAT TO COLLECT
1. The amount to send, in US dollars.
2. The recipient's name.
3. The payout method: 'upi' (a UPI ID) or 'bank' (bank account number + IFSC code).
4. The payout destination (the UPI ID, or the account number with IFSC code).

FLOW
- Once you know the amount and payout method, call get_quote and show the user the fee, the exchange rate, and the rupee amount the recipient will receive. Ask them to confirm.
- After the user confirms AND you have the recipient's name and payout destination, call create_transfer.
- Then call generate_payment_link and send the user the secure link to pay.
- If the user asks whether a transfer went through, call check_payment_status.

RULES
- Never invent exchange rates or fees. Always call get_quote for real numbers.
- Never ask for debit or credit card details in chat. Card details are entered only on the secure payment link.
- You can send between $10 and $2,999 per transfer.
- If a tool returns an error, explain it kindly and help the user correct it.
- Do not promise anything beyond sending money to India.`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — `prompt.test.ts` passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompt.ts tests/prompt.test.ts
git commit -m "feat: add agent system prompt"
```

---

## Task 8: Ollama Cloud client

**Files:**
- Create: `src/lib/ollama.ts`
- Test: `tests/ollama.test.ts`

- [ ] **Step 1: Write the failing test `tests/ollama.test.ts`**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { chat } from '@/lib/ollama';
import { toolSchemas } from '@/lib/tools';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chat', () => {
  it('posts messages to the Ollama endpoint and returns the message', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat(
      [{ role: 'user', content: 'hi' }],
      toolSchemas,
    );

    expect(result.content).toBe('Hello!');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ollama.test/v1/chat/completions');
    expect(JSON.parse(init.body).model).toBe('kimi-test');
  });

  it('throws when the response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'server error',
      })),
    );
    await expect(
      chat([{ role: 'user', content: 'hi' }], toolSchemas),
    ).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `@/lib/ollama`.

- [ ] **Step 3: Create `src/lib/ollama.ts`**

```ts
import { env } from './env';
import type { ChatMessage, ChatTool } from './types';

export async function chat(
  messages: ChatMessage[],
  tools: ChatTool[],
): Promise<ChatMessage> {
  const res = await fetch(`${env.ollamaBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ollamaApiKey}`,
    },
    body: JSON.stringify({
      model: env.ollamaModel,
      messages,
      tools,
      tool_choice: 'auto',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    choices: { message: ChatMessage }[];
  };
  return data.choices[0].message;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — `ollama.test.ts` passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ollama.ts tests/ollama.test.ts
git commit -m "feat: add Ollama Cloud chat client"
```

---

## Task 9: Agent tool-call loop

**Files:**
- Create: `src/lib/agent.ts`
- Test: `tests/agent.test.ts`

- [ ] **Step 1: Write the failing test `tests/agent.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { createAgent } from '@/lib/agent';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import type { ChatMessage } from '@/lib/types';

const PHONE = '15551234567';

describe('createAgent', () => {
  it('returns a plain reply when the model uses no tools', async () => {
    const store = createStore(fakeRedis());
    const agent = createAgent({
      store,
      chat: async () => ({ role: 'assistant', content: 'Hi there!' }),
    });
    const reply = await agent.runAgentTurn(PHONE, 'hello');
    expect(reply).toBe('Hi there!');
  });

  it('executes a tool call, then returns the follow-up reply', async () => {
    const store = createStore(fakeRedis());
    const responses: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'get_quote',
              arguments: JSON.stringify({
                amount_usd: 500,
                payout_method: 'upi',
              }),
            },
          },
        ],
      },
      { role: 'assistant', content: 'You send $500, they get a lot of INR.' },
    ];
    let call = 0;
    const agent = createAgent({
      store,
      chat: async () => responses[call++],
    });

    const reply = await agent.runAgentTurn(PHONE, 'send $500 via upi');
    expect(reply).toBe('You send $500, they get a lot of INR.');

    const conv = await store.getConversation(PHONE);
    expect(conv.some((m) => m.role === 'tool')).toBe(true);
  });

  it('saves the conversation history after a turn', async () => {
    const store = createStore(fakeRedis());
    const agent = createAgent({
      store,
      chat: async () => ({ role: 'assistant', content: 'noted' }),
    });
    await agent.runAgentTurn(PHONE, 'remember this');
    const conv = await store.getConversation(PHONE);
    expect(conv[0]).toEqual({ role: 'user', content: 'remember this' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `@/lib/agent`.

- [ ] **Step 3: Create `src/lib/agent.ts`**

```ts
import { SYSTEM_PROMPT } from './prompt';
import { toolSchemas, executeTool } from './tools';
import type { ChatMessage, ChatTool } from './types';
import type { Store } from './store';

const MAX_TOOL_ROUNDS = 6;
const FALLBACK_REPLY =
  "Sorry, I'm having trouble right now. Could you send that again?";

export interface AgentDeps {
  chat: (messages: ChatMessage[], tools: ChatTool[]) => Promise<ChatMessage>;
  store: Store;
}

export function createAgent(deps: AgentDeps) {
  async function runAgentTurn(
    phone: string,
    incomingText: string,
  ): Promise<string> {
    const history = await deps.store.getConversation(phone);
    history.push({ role: 'user', content: incomingText });

    let reply = '';

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const messages: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
      ];
      const assistant = await deps.chat(messages, toolSchemas);
      history.push(assistant);

      if (assistant.tool_calls && assistant.tool_calls.length > 0) {
        for (const call of assistant.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || '{}');
          } catch {
            args = {};
          }
          const result = await executeTool(call.function.name, args, {
            phone,
            store: deps.store,
          });
          history.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
        continue;
      }

      reply = assistant.content || '';
      break;
    }

    if (!reply) reply = FALLBACK_REPLY;
    await deps.store.saveConversation(phone, history);
    return reply;
  }

  return { runAgentTurn };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all `agent.test.ts` cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent.ts tests/agent.test.ts
git commit -m "feat: add agent tool-call loop"
```

---

## Task 10: WhatsApp client

**Files:**
- Create: `src/lib/whatsapp.ts`
- Test: `tests/whatsapp.test.ts`

- [ ] **Step 1: Write the failing test `tests/whatsapp.test.ts`**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseIncoming, sendText } from '@/lib/whatsapp';

afterEach(() => {
  vi.restoreAllMocks();
});

function textWebhook() {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  type: 'text',
                  from: '15551234567',
                  id: 'wamid.ABC',
                  text: { body: 'hello' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('parseIncoming', () => {
  it('extracts a text message', () => {
    expect(parseIncoming(textWebhook())).toEqual({
      from: '15551234567',
      text: 'hello',
      messageId: 'wamid.ABC',
    });
  });

  it('returns null for a non-text message', () => {
    const body = textWebhook();
    body.entry[0].changes[0].value.messages[0].type = 'image';
    expect(parseIncoming(body)).toBeNull();
  });

  it('returns null for an unrelated payload (e.g. status update)', () => {
    expect(parseIncoming({ entry: [{ changes: [{ value: {} }] }] })).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseIncoming(null)).toBeNull();
    expect(parseIncoming({})).toBeNull();
  });
});

describe('sendText', () => {
  it('posts a text message to the Graph API', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    await sendText('15551234567', 'hi');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/123456/messages');
    const body = JSON.parse(init.body);
    expect(body.to).toBe('15551234567');
    expect(body.text.body).toBe('hi');
  });

  it('throws when the Graph API responds with an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => 'bad request',
      })),
    );
    await expect(sendText('1', 'hi')).rejects.toThrow(/400/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `@/lib/whatsapp`.

- [ ] **Step 3: Create `src/lib/whatsapp.ts`**

```ts
import { env } from './env';

export interface IncomingMessage {
  from: string;
  text: string;
  messageId: string;
}

interface WebhookShape {
  entry?: {
    changes?: {
      value?: {
        messages?: {
          type?: string;
          from?: string;
          id?: string;
          text?: { body?: string };
        }[];
      };
    }[];
  }[];
}

export function parseIncoming(body: unknown): IncomingMessage | null {
  try {
    const message = (body as WebhookShape)?.entry?.[0]?.changes?.[0]?.value
      ?.messages?.[0];
    if (!message || message.type !== 'text') return null;
    if (!message.from || !message.id || !message.text?.body) return null;
    return {
      from: message.from,
      text: message.text.body,
      messageId: message.id,
    };
  } catch {
    return null;
  }
}

export async function sendText(to: string, text: string): Promise<void> {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${env.whatsappPhoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.whatsappToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp send failed (${res.status}): ${body}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all `whatsapp.test.ts` cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp.ts tests/whatsapp.test.ts
git commit -m "feat: add WhatsApp Cloud API client"
```

---

## Task 11: WhatsApp webhook route

**Files:**
- Create: `src/app/api/whatsapp/route.ts`
- Test: `tests/whatsapp-route.test.ts`

The test covers the GET verification handler. The POST handler is exercised
end-to-end at the agent level in Task 14 (its `after()` callback needs the Next
runtime).

- [ ] **Step 1: Write the failing test `tests/whatsapp-route.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/whatsapp/route';

describe('GET /api/whatsapp', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const req = new NextRequest(
      'http://localhost/api/whatsapp?hub.mode=subscribe&hub.verify_token=verify-test&hub.challenge=42',
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('42');
  });

  it('returns 403 when the verify token is wrong', async () => {
    const req = new NextRequest(
      'http://localhost/api/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42',
    );
    const res = await GET(req);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `@/app/api/whatsapp/route`.

- [ ] **Step 3: Create `src/app/api/whatsapp/route.ts`**

```ts
import { after, NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { parseIncoming, sendText } from '@/lib/whatsapp';
import { chat } from '@/lib/ollama';
import { createAgent } from '@/lib/agent';
import { getStore } from '@/lib/store';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  if (mode === 'subscribe' && token === env.whatsappVerifyToken && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse('Forbidden', { status: 403 });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const incoming = parseIncoming(body);
  if (!incoming) return NextResponse.json({ ok: true });

  const store = getStore();
  const isNew = await store.markMessageSeen(incoming.messageId);
  if (!isNew) return NextResponse.json({ ok: true });

  after(async () => {
    try {
      const agent = createAgent({ chat, store });
      const reply = await agent.runAgentTurn(incoming.from, incoming.text);
      await sendText(incoming.from, reply);
    } catch (err) {
      console.error('Failed to process WhatsApp message:', err);
      try {
        await sendText(
          incoming.from,
          'Sorry, something went wrong on our side. Please try again.',
        );
      } catch {
        // best effort — nothing more we can do
      }
    }
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — both `whatsapp-route.test.ts` cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/whatsapp/route.ts tests/whatsapp-route.test.ts
git commit -m "feat: add WhatsApp webhook route"
```

---

## Task 12: Mock payment — logic, route, and page

**Files:**
- Create: `src/lib/payment.ts`
- Create: `src/app/api/pay/[transferId]/route.ts`
- Create: `src/app/pay/[transferId]/page.tsx`
- Create: `src/app/pay/[transferId]/pay-form.tsx`
- Test: `tests/payment.test.ts`

- [ ] **Step 1: Write the failing test `tests/payment.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { completePayment } from '@/lib/payment';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import type { Transfer } from '@/lib/types';

function awaitingTransfer(): Transfer {
  return {
    id: 'pay12345',
    phone: '15551234567',
    amountUsd: 500,
    feeUsd: 0,
    totalChargeUsd: 500,
    fxRate: 85.2,
    amountInr: 42600,
    recipientName: 'Mom',
    payoutMethod: 'upi',
    payoutDestination: 'mom@upi',
    status: 'awaiting_payment',
    createdAt: '2026-05-21T00:00:00.000Z',
  };
}

describe('completePayment', () => {
  it('marks the transfer delivered and returns two messages', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(awaitingTransfer());

    const result = await completePayment(store, 'pay12345');

    expect(result.transfer.status).toBe('delivered');
    expect(result.transfer.paidAt).toBeTruthy();
    expect(result.transfer.deliveredAt).toBeTruthy();
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toContain('42,600');
    expect(result.messages[1]).toContain('Mom');
  });

  it('is idempotent — a second call returns no new messages', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(awaitingTransfer());
    await completePayment(store, 'pay12345');
    const second = await completePayment(store, 'pay12345');
    expect(second.transfer.status).toBe('delivered');
    expect(second.messages).toHaveLength(0);
  });

  it('throws for an unknown transfer', async () => {
    const store = createStore(fakeRedis());
    await expect(completePayment(store, 'missing')).rejects.toThrow(
      /not found/i,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `@/lib/payment`.

- [ ] **Step 3: Create `src/lib/payment.ts`**

```ts
import type { Store } from './store';
import type { Transfer } from './types';

export interface PaymentResult {
  transfer: Transfer;
  messages: string[];
}

function inr(amount: number): string {
  return amount.toLocaleString('en-IN');
}

export async function completePayment(
  store: Store,
  transferId: string,
): Promise<PaymentResult> {
  const transfer = await store.getTransfer(transferId);
  if (!transfer) {
    throw new Error(`Transfer not found: ${transferId}`);
  }
  if (transfer.status === 'delivered') {
    return { transfer, messages: [] };
  }

  const now = new Date().toISOString();
  const updated: Transfer = {
    ...transfer,
    status: 'delivered',
    paidAt: transfer.paidAt ?? now,
    deliveredAt: now,
  };
  await store.saveTransfer(updated);

  const method = updated.payoutMethod === 'upi' ? 'UPI' : 'bank transfer';
  const messages = [
    `✅ Payment received — $${updated.totalChargeUsd.toFixed(
      2,
    )} charged. Converting to rupees…`,
    `🎉 ₹${inr(updated.amountInr)} delivered to ${
      updated.recipientName
    } via ${method}. Thanks for using SendHome!`,
  ];
  return { transfer: updated, messages };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all `payment.test.ts` cases pass.

- [ ] **Step 5: Create `src/app/api/pay/[transferId]/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { completePayment } from '@/lib/payment';
import { sendText } from '@/lib/whatsapp';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ transferId: string }> },
) {
  const { transferId } = await params;
  try {
    const { transfer, messages } = await completePayment(
      getStore(),
      transferId,
    );
    for (const message of messages) {
      await sendText(transfer.phone, message);
    }
    return NextResponse.json({ ok: true, status: transfer.status });
  } catch (err) {
    console.error('Payment processing failed:', err);
    return NextResponse.json(
      { ok: false, error: 'Payment failed' },
      { status: 400 },
    );
  }
}
```

- [ ] **Step 6: Create `src/app/pay/[transferId]/pay-form.tsx`**

```tsx
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
```

- [ ] **Step 7: Create `src/app/pay/[transferId]/page.tsx`**

```tsx
import { getStore } from '@/lib/store';
import { PayForm } from './pay-form';

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="row" style={bold ? { fontWeight: 700 } : undefined}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export default async function PayPage({
  params,
}: {
  params: Promise<{ transferId: string }>;
}) {
  const { transferId } = await params;
  const transfer = await getStore().getTransfer(transferId);

  if (!transfer) {
    return (
      <main className="card">
        <div className="brand">SendHome</div>
        <h1>Transfer not found</h1>
      </main>
    );
  }

  return (
    <main className="card">
      <div className="brand">SendHome</div>
      <h1>Secure payment</h1>
      <div className="summary">
        <Row label="Recipient" value={transfer.recipientName} />
        <Row
          label="They receive"
          value={`₹${transfer.amountInr.toLocaleString('en-IN')}`}
        />
        <Row label="Amount" value={`$${transfer.amountUsd.toFixed(2)}`} />
        <Row
          label="Fee"
          value={
            transfer.feeUsd === 0 ? 'FREE' : `$${transfer.feeUsd.toFixed(2)}`
          }
        />
        <Row
          label="Total charge"
          value={`$${transfer.totalChargeUsd.toFixed(2)}`}
          bold
        />
      </div>
      {transfer.status === 'awaiting_payment' ? (
        <PayForm transferId={transfer.id} />
      ) : (
        <p className="done">✅ Payment complete — money sent!</p>
      )}
    </main>
  );
}
```

- [ ] **Step 8: Run tests and build to verify everything passes**

Run: `npm test`
Expected: PASS — all tests still pass.
Run: `npm run build`
Expected: build succeeds with no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/payment.ts "src/app/api/pay" "src/app/pay" tests/payment.test.ts
git commit -m "feat: add mock payment logic, route, and page"
```

---

## Task 13: README and environment template

**Files:**
- Create: `.env.example`, `README.md`

- [ ] **Step 1: Create `.env.example`**

```
# Ollama Cloud (Kimi K2.6)
OLLAMA_BASE_URL=https://ollama.com/v1
OLLAMA_API_KEY=
OLLAMA_MODEL=

# Meta WhatsApp Cloud API
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=choose-any-string

# Public origin of the deployed app (used to build payment links)
APP_BASE_URL=https://your-app.vercel.app

# Upstash Redis (added automatically by the Vercel Marketplace integration)
KV_REST_API_URL=
KV_REST_API_TOKEN=
```

- [ ] **Step 2: Create `README.md`**

````markdown
# SendHome — WhatsApp US→India Remittance (Prototype)

A prototype, inspired by Felix Pago, that lets a US user send money to family
in India entirely through a WhatsApp conversation. An AI agent (Kimi K2.6 on
Ollama Cloud) guides the chat in English / Hindi / Hinglish. All money movement
is mocked — no real funds move.

## Architecture

- **Next.js (App Router)** on Vercel.
- `POST /api/whatsapp` receives WhatsApp messages; the agent replies after a
  fast webhook ACK.
- The agent calls TypeScript tools (`get_quote`, `create_transfer`,
  `generate_payment_link`, `check_payment_status`) for deterministic money math.
- A mock card page at `/pay/[transferId]` triggers WhatsApp delivery messages.
- State (conversations, transfers) lives in Upstash Redis.

## Setup

1. **Install:** `npm install`
2. **Upstash Redis:** in the Vercel dashboard, add the Upstash Redis
   integration from the Marketplace. It sets `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` automatically.
3. **Ollama Cloud:** set `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`, and `OLLAMA_MODEL`
   (the exact Kimi K2.6 model tag).
4. **Meta WhatsApp:** create a Meta app with WhatsApp, note the test number's
   `WHATSAPP_PHONE_NUMBER_ID` and a `WHATSAPP_TOKEN`. Add the demo recipient's
   phone number to the test number's allowed recipients.
5. **Deploy:** push to Vercel. Set `APP_BASE_URL` to the deployed URL.
6. **Webhook:** in the Meta app, set the WhatsApp webhook callback URL to
   `https://<your-app>/api/whatsapp` and the verify token to your
   `WHATSAPP_VERIFY_TOKEN`. Subscribe to the `messages` field.

Copy `.env.example` to `.env.local` for local development.

## Testing

`npm test` runs the Vitest suite (FX math, store, tools, agent loop, payment,
WhatsApp parsing, webhook verification, and an end-to-end happy path).

## Scope

This is a concept demo. Out of scope: real KYC, real payment/payout rails,
AML/compliance, live FX feeds, voice notes, and corridors other than US→India.
````

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "docs: add README and env template"
```

---

## Task 14: End-to-end happy-path integration test

**Files:**
- Test: `tests/e2e.test.ts`

This test wires the real agent, real tools, and real store (with a fake Redis)
together, using a scripted `chat` that simulates Kimi driving a full transfer.
It then runs the mock payment and asserts delivery.

- [ ] **Step 1: Write the failing test `tests/e2e.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { createAgent } from '@/lib/agent';
import { createStore } from '@/lib/store';
import { completePayment } from '@/lib/payment';
import { fakeRedis } from './helpers';
import type { ChatMessage } from '@/lib/types';

const PHONE = '15551234567';

function toolCall(id: string, name: string, args: object): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

describe('end-to-end happy path', () => {
  it('quotes, creates a transfer, sends a link, and delivers', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);

    // Scripted Kimi: quote -> create -> link -> final reply.
    const script: ChatMessage[] = [
      toolCall('c1', 'get_quote', {
        amount_usd: 500,
        payout_method: 'upi',
      }),
      toolCall('c2', 'create_transfer', {
        amount_usd: 500,
        recipient_name: 'Mom',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
      }),
      toolCall('c3', 'generate_payment_link', {
        transfer_id: 'PLACEHOLDER',
      }),
      {
        role: 'assistant',
        content: 'Tap the link to pay securely and your mom gets the money.',
      },
    ];
    let turn = 0;
    const agent = createAgent({
      store,
      async chat() {
        const msg = script[turn++];
        // Patch the real transfer id into the link tool call.
        if (msg.tool_calls?.[0].function.name === 'generate_payment_link') {
          const transferKey = [...redis.dump.keys()].find((k) =>
            k.startsWith('transfer:'),
          )!;
          const id = transferKey.replace('transfer:', '');
          msg.tool_calls[0].function.arguments = JSON.stringify({
            transfer_id: id,
          });
        }
        return msg;
      },
    });

    const reply = await agent.runAgentTurn(
      PHONE,
      'send $500 to my mom on UPI mom@upi',
    );
    expect(reply).toContain('pay');

    // A transfer was created and the user count incremented.
    const transferKey = [...redis.dump.keys()].find((k) =>
      k.startsWith('transfer:'),
    )!;
    const transferId = transferKey.replace('transfer:', '');
    expect((await store.getUser(PHONE)).transferCount).toBe(1);

    // Completing payment delivers the money.
    const result = await completePayment(store, transferId);
    expect(result.transfer.status).toBe('delivered');
    expect(result.messages[1]).toContain('42,600');

    // First transfer was free.
    expect(result.transfer.feeUsd).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `npm test`
Expected: the test passes if all prior tasks are complete (it depends only on
already-built modules). If it fails, the failure points at a real integration
bug — fix the implicated module before continuing.

- [ ] **Step 3: Run the full suite and build**

Run: `npm test`
Expected: PASS — every test file passes.
Run: `npm run build`
Expected: build succeeds with no type errors.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e.test.ts
git commit -m "test: add end-to-end happy-path integration test"
```

---

## Manual Verification (after deployment)

These steps need real credentials and a deployed app — they are not automated.

1. Deploy to Vercel with all environment variables set.
2. In the Meta dashboard, configure the webhook URL and verify token; confirm
   the webhook verifies (green check).
3. Add the demo phone number to the test number's allowed recipients.
4. From that phone, message the bot: "I want to send $500 to my mom in India".
5. Walk the conversation: provide a UPI ID, confirm the quote, open the payment
   link, submit a test card.
6. Confirm two WhatsApp messages arrive: payment received, then delivery.
7. Try a second transfer and confirm the $2.99 fee now appears.

---

## Self-Review Notes

- **Spec coverage:** webhook (Task 11), agent + tools (Tasks 6, 9), Ollama/Kimi
  (Task 8), mocked FX/fees (Task 4), Redis data model (Task 5), mock payment +
  live delivery ping (Task 12), error handling (webhook dedupe + try/catch in
  Tasks 11–12), testing (Tasks 4–14), config/env (Task 3, 13). All spec
  sections map to a task.
- **JSON-mode fallback:** the spec mentions a fallback if native tool-calling is
  unreliable. Native tool-calling is implemented (Task 9). The fallback is
  intentionally deferred — it is only built if manual verification shows Kimi's
  tool-calling over Ollama is unreliable, to avoid speculative code (YAGNI). If
  needed, it is a localized change inside `agent.ts` + `ollama.ts`.
- **Type consistency:** `Transfer`, `Quote`, `ChatMessage`, `ChatTool`,
  `Store`, `RedisLike` are defined once and reused; tool result keys are
  snake_case (LLM-facing), internal fields camelCase (consistent throughout).
