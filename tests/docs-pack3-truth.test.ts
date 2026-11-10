// Fix pack 3 T14 (R15, R27, R13, R26; contract 20): the documents that state
// the pack's rules say what the built code does. Read from disk, like
// tests/sanctions-spec-truth.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/** The paragraph of `text` that starts with `start` (up to the next blank line). */
function paragraph(text: string, start: string): string {
  const at = text.indexOf(start);
  expect(at, `paragraph "${start}"`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n\n', at);
  return text.slice(at, end === -1 ? undefined : end);
}

describe('pack 3 documents say what the code does', () => {
  const rollback = read('docs/ROLLBACK.md');
  const pr3 = (): string => paragraph(rollback, 'PR3 (live controls)');

  it('ROLLBACK.md warns never to switch a rail with paid or charged live rows to simulator', () => {
    const p = pr3();
    expect(p).toContain('simulator');
    expect(p).toContain('no payout');
    expect(p).toMatch(/NEVER switch a rail that has any `paid`, `in_review` or charged/);
  });

  it('ROLLBACK.md names live_controls, tenant:, livegate:, the four partner switches and "what to check first"', () => {
    const p = pr3();
    for (const s of ['`partners.live_controls jsonb', '0037', '`tenant:', '`livegate:<id>`', '`flagread:`', 'What to check first']) expect(p, s).toContain(s);
    for (const s of ['sends', 'settlement', 'AI agent', 'AI agent tools']) expect(p, s).toContain(s);
    const bullet = rollback.split('\n').find((l) => l.startsWith('- **Kill switches**'))!;
    expect(bullet).toContain('`/partner/controls`');
    expect(bullet).toMatch(/unreadable `settlement.paused` waits on real-money rails/);
  });

  it('CLAUDE.md release safety line names agent.paused, agent.tools.paused, tenant rows, applyPartnerFlagChange, /partner/controls, flagread: and says settlement.paused waits when unreadable on a real-money rail', () => {
    const line = read('CLAUDE.md').split('\n').find((l) => l.startsWith('- **Release safety (Batch 2)**'))!;
    for (const s of ['`agent.paused`', '`agent.tools.paused`', '`tenant:<id>[:<CC>]`', '`applyPartnerFlagChange`', '`/partner/controls`', '`flagread:<key>:<hour>`', '`applyFlagChange`']) {
      expect(line, s).toContain(s);
    }
    expect(line).toMatch(/`settlement.paused` at the instruct and the stuck-paid sweep on a real-money rail, which waits uncharged when unreadable \(Q5\)/);
    // The rest of the bullet stays.
    expect(line).toContain('`release-check.yml`');
    expect(line).toContain('`docs/ROLLBACK.md`');
  });

  it('CLAUDE.md release safety line no longer says only "fail open"', () => {
    const line = read('CLAUDE.md').split('\n').find((l) => l.startsWith('- **Release safety (Batch 2)**'))!;
    expect(line).not.toContain('reads cached 15 s, fail open;');
    expect(line).toContain('except');
  });

  it('go-live.mdx names partner_not_live, capability_off and the Controls page; errors.mdx 403 row names both codes; openapi.yaml 403 of create and confirm name partner_not_live', () => {
    const goLive = read('src/content/docs/go-live.mdx');
    expect(goLive).toContain('### Live money on your own rail');
    expect(goLive).toContain('### Your switches');
    expect(goLive).toContain('`partner_not_live`');
    expect(goLive).toContain('`capability_off`');
    expect(goLive).toContain('Controls page');
    expect(goLive).not.toMatch(/simulator/i);
    const row403 = read('src/content/docs/errors.mdx').split('\n').find((l) => l.startsWith('| `403`'))!;
    expect(row403).toContain('`partner_not_live`');
    expect(row403).toContain('`capability_off`');
    const yaml = read('openapi.yaml');
    const op = (id: string): string => {
      const at = yaml.indexOf(`operationId: ${id}`);
      expect(at, id).toBeGreaterThanOrEqual(0);
      return yaml.slice(at, yaml.indexOf("'429'", at));
    };
    const create403 = op('createTransaction').split('\n').find((l) => l.includes("'403'"))!;
    const confirm403 = op('confirmTransaction').split('\n').find((l) => l.includes("'403'"))!;
    expect(create403).toContain('(code partner_not_live)');
    expect(create403).toContain('(code capability_off)');
    expect(confirm403).toContain('(code partner_not_live)');
    expect(confirm403).not.toContain('capability_off');
    // The API reference page prints response descriptions as plain text
    // (tests/docs-api-page.test.ts refuses a literal backtick in the page).
    expect(create403).not.toContain("`");
    expect(confirm403).not.toContain("`");
  });

  // Review P3 (D1, E2): on the Partner API only a USDC payout can reach the
  // capability gate (partner-api-service.ts mints with fundingMethod
  // 'bank_transfer', no transferType, no scheduleId), so 403 capability_off is
  // tied to USDC there; the other three features are closed on the customer
  // surfaces with a neutral message.
  it('go-live.mdx, errors.mdx and openapi.yaml tie 403 capability_off to a USDC payout on a Partner API transaction only', () => {
    const goLive = read('src/content/docs/go-live.mdx');
    const sentences = goLive.split(/(?<=\.)\s+/);
    const capSentences = sentences.filter((s) => s.includes('capability_off'));
    expect(capSentences.length).toBeGreaterThan(0);
    for (const s of capSentences) {
      expect(s, s).toMatch(/USDC payout/);
      expect(s, s).toMatch(/Partner API/);
      expect(s, s).toContain('`403`');
      expect(s, s).not.toMatch(/business payments|repeat payments|AI apps/i);
    }
    const others = sentences.find((s) => /business payments/i.test(s) && /repeat payments/.test(s) && /AI apps/.test(s));
    expect(others, 'a sentence naming the other three features').toBeDefined();
    expect(others!).not.toContain('403');
    expect(others!).toMatch(/neutral message/);
    for (const surface of ['chat', 'portal', 'pay pages']) expect(others!, surface).toContain(surface);

    const row403 = read('src/content/docs/errors.mdx').split('\n').find((l) => l.startsWith('| `403`'))!;
    expect(row403).toMatch(/USDC payout[^|]*\(`capability_off`\)/);
    expect(row403).not.toMatch(/business payments|repeat payments|AI apps/i);

    const yaml = read('openapi.yaml');
    const at = yaml.indexOf('operationId: createTransaction');
    const create403 = yaml.slice(at, yaml.indexOf("'429'", at)).split('\n').find((l) => l.includes("'403'"))!;
    expect(create403).toMatch(/USDC payout[^']*\(code capability_off\)/);
    expect(create403).not.toContain('`');
  });

  // Review P3 (E3): the older build has no agent.paused / agent.tools.paused
  // keys (ba8eb39 flags.ts FLAG_DEFINITIONS; its switches page renders only
  // FLAG_KEYS), so it neither shows nor honours such rows at any scope.
  it('ROLLBACK.md PR3 paragraph queries the agent pause rows at any scope and says the older build neither shows nor honours them, and they apply again at roll-forward', () => {
    const p = pr3();
    expect(p).toContain("key IN ('agent.paused','agent.tools.paused')");
    expect(p).toMatch(/neither shows nor honours/);
    expect(p).toMatch(/no substitute/);
    expect(p).toMatch(/roll-forward/);
    // The "partner tenant:x / platform row" advice is for the two keys the old build knows.
    expect(p).toMatch(/`sends\.paused` and `settlement\.paused`[^;]*partner tenant:x/);
  });

  it('flags.ts header names tenant rows and Q5', () => {
    const src = read('src/lib/flags.ts');
    const header = src.slice(src.indexOf('// flags'), src.indexOf('export const FLAG_CACHE_TTL_MS'));
    for (const s of ['tenantScopeId', 'parseTenantScopeId', 'Q5', 'applyFlagChange', 'applyPartnerFlagChange', '/partner/controls', '/admin-dashboard/switches']) {
      expect(header, s).toContain(s);
    }
    expect(header).toMatch(/sends\.paused matches the owner/);
    expect(header).toMatch(/settlement\.paused the owner or the rail/);
  });
});
