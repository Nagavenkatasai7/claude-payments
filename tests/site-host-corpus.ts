// Shared host corpus for the host parser (tests/site-host.test.ts), the compiled-matcher parity
// test (tests/site-matcher-parity.test.ts), the apex no-op oracle (tests/proxy-apex-noop.test.ts)
// and the subdomain proxy tests (tests/proxy-site.test.ts).
//
// APEX    = the platform itself: smartremit.ai and www.smartremit.ai (any case, any port), plus every
//           host that is not under smartremit.ai at all (previews, localhost, IPs, look-alikes).
// SITE    = <valid slug>.smartremit.ai.
// REFUSED = every other *.smartremit.ai host (reserved labels, ??-- labels, bad lengths or edges,
//           multi-label names, the trailing-dot form). Never served by the apex app.
import { RESERVED_SLUGS } from '@/lib/site-host';

export const SITE_HOSTS: Array<[host: string, slug: string]> = [
  ['acme.smartremit.ai', 'acme'], ['ACME.SmartRemit.AI', 'acme'], ['acme.smartremit.ai:443', 'acme'],
  ['my-remit-co.smartremit.ai', 'my-remit-co'], ['a1b.smartremit.ai', 'a1b'], [`${'a'.repeat(30)}.smartremit.ai`, 'a'.repeat(30)],
  ['a-b--c.smartremit.ai', 'a-b--c'],
];

export const APEX_HOSTS: string[] = [
  'smartremit.ai', 'SMARTREMIT.AI', 'smartremit.ai:443', 'smartremit.ai.', 'www.smartremit.ai', 'WWW.SmartRemit.ai:443',
  'www.smartremit.ai.', '.smartremit.ai',
  'smartremit.ai.evil.com', 'acme.smartremit.ai.evil.com', 'evilsmartremit.ai', 'acme.evilsmartremit.ai',
  'claude-payments.vercel.app', 'claude-payments-git-feat-x-team.vercel.app', 'localhost', 'localhost:3000',
  'acme.localhost', '127.0.0.1', '127.0.0.1:3000', '[::1]', '[::1]:3000', '',
];

export const REFUSED_HOSTS: string[] = [
  // EVERY reserved label (except www, which is apex), generated from the set, so the parity test fails if
  // the static-literal lookahead in config.matcher and RESERVED_SLUGS ever drift apart.
  ...[...RESERVED_SLUGS].filter((r) => r !== 'www').map((r) => `${r}.smartremit.ai`),
  ...[...RESERVED_SLUGS].filter((r) => r !== 'www').map((r) => `${r.toUpperCase()}.smartremit.ai:443`),
  'xn--80ak6aa92e.smartremit.ai', 'XN--ABC.smartremit.ai', 'ab--cd.smartremit.ai', 'a.b.smartremit.ai', 'www.acme.smartremit.ai',
  'acme.www.smartremit.ai', 'acme.smartremit.ai.', 'ACME.smartremit.ai.:443', 'ab.smartremit.ai', 'a.smartremit.ai',
  `${'a'.repeat(31)}.smartremit.ai`, '-acme.smartremit.ai', 'acme-.smartremit.ai', 'ac_me.smartremit.ai', 'www2.smartremit.ai',
];
