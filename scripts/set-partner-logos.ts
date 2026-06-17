/**
 * Give every demo partner a clean, distinct logo so the pay page + partner pages
 * showcase real branding for the demo.
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/set-partner-logos.ts
 *
 * Each logo is a tiny generated SVG (a colored pill: initial mark + wordmark),
 * stored as a base64 image DATA URI in the PLAINTEXT partners.logo_url column —
 * no crypto key, no Redis, no external host. The CSP already allows `img-src
 * data:`, so it renders on the pay page (raw <img>) and the admin partner pages.
 * Idempotent (re-running just rewrites the same logo). Matches what an admin would
 * produce by uploading an image in the partner wizard / Settings tab.
 */
import { getPartnerStore } from '@/lib/partner-store';

interface LogoTarget {
  id: string;
  wordmark: string;
  initial: string;
  color: string;
}

// Live prod partner ids (smoke partners removed). Default included so the
// default-tenant pay page — what the WhatsApp demo customer sees — is branded.
const TARGETS: LogoTarget[] = [
  { id: 'default',  wordmark: 'SmartRemit',     initial: 'S', color: '#25d366' },
  { id: 'nt1xjr18', wordmark: 'Acme Remit',     initial: 'A', color: '#533afd' },
  { id: 'u7z3tz4y', wordmark: 'Britannia Send', initial: 'B', color: '#0b5cab' },
  { id: 'r31qf4e8', wordmark: 'Gulf Money',     initial: 'G', color: '#0e8a6a' },
  { id: 'jztp1b50', wordmark: 'Lion Pay',       initial: 'L', color: '#c2410c' },
];

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!
  ));
}

function logoDataUri(t: LogoTarget): string {
  // Width grows with the wordmark so long names ("Britannia Send") never clip.
  const w = Math.max(160, 64 + t.wordmark.length * 10);
  const font = `'Segoe UI',Helvetica,Arial,sans-serif`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="52" viewBox="0 0 ${w} 52">` +
    `<rect width="${w}" height="52" rx="12" fill="${t.color}"/>` +
    `<circle cx="30" cy="26" r="13" fill="#ffffff" fill-opacity="0.18"/>` +
    `<text x="30" y="31" font-family="${font}" font-size="16" font-weight="800" fill="#ffffff" text-anchor="middle">${escapeXml(t.initial)}</text>` +
    `<text x="54" y="32" font-family="${font}" font-size="18" font-weight="700" fill="#ffffff">${escapeXml(t.wordmark)}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

async function main() {
  const partnerStore = getPartnerStore();
  console.log(`\nSetting logos on ${TARGETS.length} partners\n`);

  for (const t of TARGETS) {
    const existing = await partnerStore.getPartner(t.id);
    if (!existing) {
      console.log(`  • skip ${t.id.padEnd(12)} (not found)`);
      continue;
    }
    const logoUrl = logoDataUri(t);
    await partnerStore.savePartner({ ...existing, logoUrl, updatedAt: new Date().toISOString() });
    console.log(`  ✓ ${t.wordmark.padEnd(16)} ← ${t.id}  (${logoUrl.length} byte data URI)`);
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log('LOGOS SET — pay page + /admin-dashboard/partners/<id> now show each brand logo.');
  console.log('Admins can replace any logo by uploading an image in the partner Settings tab.');
  console.log('');
}

main().then(() => process.exit(0)).catch((e) => { console.error('set-logos failed:', e); process.exit(1); });
