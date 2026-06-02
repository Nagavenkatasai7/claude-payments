// Persona sandbox spike (Phase 2, Task 0) — confirm exact API shapes against the
// REAL sandbox so the integration is built on facts, not guesses.
// Run: node --env-file=.env.local scripts/persona-spike.mjs
// Reads secrets ONLY from .env.local (gitignored); writes NO secrets to fixtures.
import { writeFileSync, mkdirSync } from 'node:fs';

const KEY = process.env.PERSONA_API_KEY;
const TEMPLATE_VERSION = process.env.PERSONA_INQUIRY_TEMPLATE_VERSION_ID;
const VERSION = process.env.PERSONA_API_VERSION ?? '2025-12-08';
if (!KEY || !TEMPLATE_VERSION) {
  console.error('Missing PERSONA_API_KEY or PERSONA_INQUIRY_TEMPLATE_VERSION_ID in .env.local');
  process.exit(1);
}

const BASES = [
  process.env.PERSONA_API_BASE,
  'https://api.withpersona.com/api/v1',
  'https://withpersona.com/api/v1',
].filter(Boolean);

const headers = (extra = {}) => ({
  Authorization: `Bearer ${KEY}`,
  'Persona-Version': VERSION,
  'Key-Inflection': 'kebab',
  'Content-Type': 'application/json',
  ...extra,
});

mkdirSync('tests/fixtures/persona', { recursive: true });
const dump = (name, obj) => {
  writeFileSync(`tests/fixtures/persona/${name}.json`, JSON.stringify(obj, null, 2));
};

async function tryCreate() {
  for (const base of BASES) {
    try {
      const r = await fetch(`${base}/inquiries`, {
        method: 'POST',
        headers: headers({ 'Idempotency-Key': `spike-${VERSION}-1` }),
        body: JSON.stringify({
          data: { attributes: { 'inquiry-template-version-id': TEMPLATE_VERSION, 'reference-id': 'spike-customer-0001' } },
        }),
      });
      const j = await r.json();
      console.log(`\n[create @ ${base}] HTTP ${r.status}`);
      if (j?.data?.id) { dump('inquiry-created', j); return { base, created: j }; }
      console.log('  no data.id — response head:', JSON.stringify(j).slice(0, 400));
    } catch (e) {
      console.log(`  [create @ ${base}] threw:`, e.message);
    }
  }
  return null;
}

const made = await tryCreate();
if (!made) { console.error('\nCould not create an inquiry at any base. Inspect the responses above (key/template/version/headers).'); process.exit(1); }
const { base, created } = made;
const inquiryId = created.data.id;

const otlRes = await fetch(`${base}/inquiries/${inquiryId}/generate-one-time-link`, { method: 'POST', headers: headers() });
const otl = await otlRes.json();
dump('one-time-link', otl);
console.log(`\n[one-time-link] HTTP ${otlRes.status}`);

const gotRes = await fetch(`${base}/inquiries/${inquiryId}`, { headers: headers() });
const got = await gotRes.json();
dump('inquiry-get', got);

// Probe the one-time-link path heuristically so we can record the exact JSON path.
const findLink = (o, path = '') => {
  if (typeof o === 'string' && /one-time-link|magic|sessionToken|verify\?/.test(o)) return [[path, o.slice(0, 80)]];
  if (o && typeof o === 'object') return Object.entries(o).flatMap(([k, v]) => findLink(v, path ? `${path}.${k}` : k));
  return [];
};

console.log('\n================ CONFIRMED FACTS (record these in the plan) ================');
console.log('working base URL :', base);
console.log('inquiry id       :', inquiryId, '(data.id)');
console.log('inquiry status   :', got?.data?.attributes?.status);
console.log('reference-id     :', got?.data?.attributes?.['reference-id']);
console.log('one-time-link @  :', JSON.stringify(findLink(otl)));
console.log('inquiry attr keys:', Object.keys(got?.data?.attributes ?? {}).join(', '));
console.log('fixtures written : tests/fixtures/persona/{inquiry-created,one-time-link,inquiry-get}.json');
