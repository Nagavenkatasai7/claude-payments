import { createHash } from 'node:crypto';
import { chat } from '@/lib/ollama';
import type { RedisLike } from '@/lib/store';
import type { ChatMessage } from '@/lib/types';
import type { CorridorDemand } from '@/lib/corridor-demand';

// corridor-brief-ai — the platform launch-recommender's ONE-shot AI narration
// (rung-1: the model only NARRATES numbers the deterministic aggregator already
// computed; it never decides, never mutates, never invents). One chat(.., [])
// call, no tools, no agent loop. Any failure is caught by the caller and the
// brief is simply hidden — the ranked table (the real product) always renders.
//
// The model is handed ONLY counts/sums/percentages — never a sender phone
// number (the aggregator strips those by construction). Its job is to turn the
// top-N rows into a short, scannable expansion brief for the platform team.

// Forbidden-content rules — interpolated verbatim into the system prompt, the
// same block as ticket-ai.ts (tests/corridor-brief-ai.test.ts guards presence).
const GUARDRAILS = `Hard rules — never break these:
- Never make promises or guarantees of any kind: no delivery promises, no timing guarantees, no outcome guarantees.
- Never commit to a refund or imply one will happen. If refunds come up, say only that our team reviews refunds.
- Never reveal compliance, screening, sanctions, or review detail. At most, say a transfer is being reviewed.
- Never give financial advice — no advice on rates, timing, amounts, or currencies.
- Never invent transaction facts. Mention only facts explicitly present in the provided context; if something is unknown, say the team will check and follow up.`;

const BRIEF_SYSTEM = `You are a market-expansion analyst for a money-transfer platform. You are given a ranked table of inbound DEMAND for destination countries we don't deliver to yet — each row carries lead counts, distinct-sender counts, a growth trend, and a best-effort USD-equivalent demand figure. Write a SHORT expansion brief: one tight paragraph (2-4 sentences) per destination, in ranked order, that a product team can skim. For each, state the demand plainly (e.g. "X leads from Y senders, +Z% recently, currently unsupported") and whether it looks worth prioritising for launch. Plain text only — no markdown headers, no tables, no placeholders. Narrate ONLY the numbers you are given; do not invent leads, senders, amounts, or growth figures, and never imply a launch decision has been made.

${GUARDRAILS}`;

/** Render one ranked row into a compact, model-readable fact line (counts/sums only). */
function rowLine(d: CorridorDemand, rank: number): string {
  const t = d.total;
  const growth =
    d.growthLeads == null
      ? 'trend: not enough history'
      : d.growthPct == null
        ? `trend: +${d.growthLeads} leads vs prior window`
        : `trend: ${d.growthLeads >= 0 ? '+' : ''}${Math.round(d.growthPct)}% (${d.growthLeads >= 0 ? '+' : ''}${d.growthLeads}) vs prior window`;
  const usd =
    t.pricedLeads > 0
      ? `~$${Math.round(t.usdDemand).toLocaleString('en-US')} USD across ${t.pricedLeads} priced ${t.pricedLeads === 1 ? 'lead' : 'leads'}`
      : 'no amounts captured';
  const status = d.supported ? 'ALREADY SUPPORTED' : 'currently unsupported';
  return `${rank}. ${d.destination} — ${t.leads} ${t.leads === 1 ? 'lead' : 'leads'}, ${t.distinctSenders} distinct ${t.distinctSenders === 1 ? 'sender' : 'senders'}, ${growth}, ${usd}, ${status}.`;
}

/**
 * Narrate the top-N ranked destinations as a short prose expansion brief.
 * Returns the model's text (trimmed). Throws on an empty reply OR when there
 * are no rows to narrate — the caller try/catches and just hides the brief.
 */
export async function narrateCorridorBrief(
  ranked: CorridorDemand[],
  topN = 5,
): Promise<string> {
  const top = ranked.slice(0, topN);
  if (top.length === 0) throw new Error('No corridor demand to narrate');
  return narrateTable(factTable(top));
}

function factTable(top: CorridorDemand[]): string {
  return top.map((d, i) => rowLine(d, i + 1)).join('\n');
}

async function narrateTable(table: string): Promise<string> {
  const user: ChatMessage = {
    role: 'user',
    content: `Ranked demand table (highest first):\n${table}\n\nWrite the expansion brief.`,
  };
  const reply = await chat([{ role: 'system', content: BRIEF_SYSTEM }, user], []);
  const text = (reply.content ?? '').trim();
  if (!text) throw new Error('Empty AI response');
  return text;
}

// ── Cached entry point for the admin Corridors page ─────────────────────────
// A model call takes seconds and can run to OLLAMA_TIMEOUT_MS, so the page
// streams the brief in after the table and reuses one brief per set of top-N
// numbers for an hour. The key is a hash of the fact table (counts and sums
// only), so new demand gets a fresh brief and nothing readable is stored in the
// key. The cache is best-effort: any Redis error just means one more model call.

export const BRIEF_CACHE_TTL_S = 3600;

export type BriefCache = Pick<RedisLike, 'get' | 'set'>;

// Skipped under vitest by default (same reason as rate.ts's FX L2: tests stub
// global fetch, which the Upstash REST client also rides). Tests pass a fake.
async function defaultBriefCache(): Promise<BriefCache | null> {
  if (process.env.VITEST) return null;
  try {
    const { getRedis } = await import('./redis');
    return getRedis();
  } catch {
    return null;
  }
}

// Page loads that land together on one instance share a single model call.
const inflight = new Map<string, Promise<string>>();

/**
 * The brief for the top-N ranked destinations, from the shared cache when the
 * same numbers were narrated in the last hour. Throws like narrateCorridorBrief
 * (nothing to narrate, empty reply, model error); failures are never cached.
 * Pass `cache: null` to skip caching; omit it to use the shared Redis.
 */
export async function getCorridorBrief(
  ranked: CorridorDemand[],
  topN = 5,
  cache?: BriefCache | null,
): Promise<string> {
  const top = ranked.slice(0, topN);
  if (top.length === 0) throw new Error('No corridor demand to narrate');
  const table = factTable(top);
  const key = `corridor-brief:v1:${createHash('sha256').update(table).digest('hex').slice(0, 32)}`;

  const store = cache === undefined ? await defaultBriefCache() : cache;
  if (store) {
    try {
      const hit = await store.get(key);
      if (hit) return hit;
    } catch {
      /* fail-open: narrate below */
    }
  }

  const running = inflight.get(key);
  if (running) return running;

  const call = (async () => {
    const text = await narrateTable(table);
    if (store) {
      try {
        await store.set(key, text, { ex: BRIEF_CACHE_TTL_S });
      } catch {
        /* best effort */
      }
    }
    return text;
  })();
  inflight.set(key, call);
  try {
    return await call;
  } finally {
    inflight.delete(key);
  }
}
