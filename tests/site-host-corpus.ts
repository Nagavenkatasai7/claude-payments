// Shared host corpus for the host parser (tests/site-host.test.ts), the compiled-matcher parity
// test (tests/site-matcher-parity.test.ts) and the apex no-op oracle (tests/proxy-apex-noop.test.ts).
import { RESERVED_SLUGS } from '@/lib/site-host';

export const SITE_HOSTS: Array<[host: string, slug: string]> = [
  ['acme.smartremit.ai', 'acme'], ['ACME.SmartRemit.AI', 'acme'], ['acme.smartremit.ai:443', 'acme'],
  ['my-remit-co.smartremit.ai', 'my-remit-co'], ['a1b.smartremit.ai', 'a1b'], [`${'a'.repeat(30)}.smartremit.ai`, 'a'.repeat(30)],
  ['a-b--c.smartremit.ai', 'a-b--c'],
];

export const APEX_HOSTS: string[] = [
  'smartremit.ai', 'SMARTREMIT.AI', 'smartremit.ai:443', 'www.smartremit.ai', 'api.smartremit.ai', 'admin.smartremit.ai',
  'partner.smartremit.ai', 'docs.smartremit.ai', 'trust.smartremit.ai', 'status.smartremit.ai', 'mail.smartremit.ai',
  'app.smartremit.ai', 'smartremit.smartremit.ai', 'xn--80ak6aa92e.smartremit.ai', 'XN--ABC.smartremit.ai', 'ab--cd.smartremit.ai',
  'a.b.smartremit.ai', 'acme.smartremit.ai.',
  'smartremit.ai.evil.com', 'acme.smartremit.ai.evil.com', 'evilsmartremit.ai', 'acme.evilsmartremit.ai', 'ab.smartremit.ai',
  `${'a'.repeat(31)}.smartremit.ai`, '-acme.smartremit.ai', 'acme-.smartremit.ai', 'ac_me.smartremit.ai',
  // EVERY reserved label, generated from the set, so the parity test fails if the static-literal lookahead in
  // config.matcher and RESERVED_SLUGS ever drift apart.
  ...[...RESERVED_SLUGS].map((r) => `${r}.smartremit.ai`), ...[...RESERVED_SLUGS].map((r) => `${r.toUpperCase()}.smartremit.ai:443`),
  'claude-payments.vercel.app', 'claude-payments-git-feat-x-team.vercel.app', 'localhost', 'localhost:3000',
  'acme.localhost', '127.0.0.1', '127.0.0.1:3000', '[::1]', '[::1]:3000', '', ' acme.smartremit.ai', 'acme.smartremit.ai ',
];
