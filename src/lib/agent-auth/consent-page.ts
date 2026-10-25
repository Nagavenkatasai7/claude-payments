import { t, type MessageKey } from '@/lib/i18n';
import type { AgentScope } from './contract';

// The /oauth/authorize HTML (Stage C1): the consent screen and the plain message pages. PURE.
//
// Rendered by the route handler itself (not a React page) so the route owns every header of the
// response, the per-response CSP included (authorize-csp.ts). Every interpolated value goes
// through esc(); the client name is UNVERIFIED text, so it is escaped, already length-capped at
// registration, and never a link. No script; inline style only (style-src 'unsafe-inline' is
// already in the site CSP).

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--ink:#14181f;--muted:#5b6472;--line:#dfe3e8;--brand:#0c5bd2;--brand-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--card:#171b21;--ink:#eef1f5;--muted:#a3acb9;--line:#2a313b;--brand:#4d8ef0;--brand-ink:#0b0e12}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:480px;margin:0 auto;padding:40px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
.brand{font-weight:700;font-size:15px;letter-spacing:.2px;margin:0 0 20px}
h1{font-size:21px;line-height:1.3;margin:0 0 14px}
p{margin:0 0 12px}.muted{color:var(--muted);font-size:14px}
ul{margin:0 0 16px;padding-left:20px}li{margin:4px 0}
.name{font-weight:700;overflow-wrap:anywhere}
.no{font-weight:600}
.row{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap}
button{font:inherit;font-weight:600;border-radius:10px;padding:10px 18px;cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--ink)}
button.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
button:focus-visible{outline:3px solid var(--brand);outline-offset:2px}
`;

function page(title: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    '<meta name="referrer" content="same-origin">' + // no-referrer would send `Origin: null` on the form POST
    `<title>${esc(title)}</title><style>${STYLE}</style></head>` +
    `<body><main id="main"><div class="card"><p class="brand">SmartRemit</p>${body}</div></main></body></html>`
  );
}

export interface ConsentView {
  /** The app's self-chosen name (unverified). '' = it gave none. */
  clientName: string;
  /** The opaque server-side ticket that carries the validated request. */
  ticket: string;
  /** The host the browser returns to (from the validated redirect_uri), shown so the customer can check it. */
  returnHost: string;
  /** The scopes this consent grants (canonical order); one line each. */
  scopes: readonly AgentScope[];
}

const SCOPE_LINE: Record<AgentScope, MessageKey> = {
  'quotes:read': 'agent.consent.quotes',
  'recipients:read': 'agent.consent.recipients',
  'transfers:read': 'agent.consent.transfers',
  'transfers:prepare': 'agent.consent.prepare',
  'schedules:manage': 'agent.consent.schedules',
};

export function renderConsentPage(v: ConsentView): string {
  const who = v.clientName === '' ? esc(t('agent.consent.unnamed')) : `<span class="name">“${esc(v.clientName)}”</span>`;
  const body =
    `<h1>${esc(t('agent.consent.title'))}</h1>` +
    `<p>${t('agent.consent.intro', { app: '\u0000' }).split('\u0000').map(esc).join(who)}</p>` +
    '<ul>' +
    v.scopes.map((s) => `<li>${esc(t(SCOPE_LINE[s]))}</li>`).join('') +
    '</ul>' +
    `<p class="no">${esc(t(v.scopes.includes('transfers:prepare') || v.scopes.includes('schedules:manage') ? 'agent.consent.cannotPay' : 'agent.consent.cannot'))}</p>` +
    `<p class="muted">${esc(t('agent.consent.unverified'))}</p>` +
    `<p class="muted">${esc(t('agent.consent.returnTo', { host: v.returnHost }))}</p>` +
    `<p class="muted">${esc(t('agent.consent.disconnect'))}</p>` +
    '<form method="post" action="/oauth/authorize">' +
    `<input type="hidden" name="ticket" value="${esc(v.ticket)}">` +
    '<div class="row">' +
    `<button class="primary" type="submit" name="decision" value="allow">${esc(t('agent.consent.allow'))}</button>` +
    `<button type="submit" name="decision" value="deny">${esc(t('agent.consent.deny'))}</button>` +
    '</div></form>';
  return page(t('agent.consent.pageTitle'), body);
}

export function renderMessagePage(v: { title: string; body: string }): string {
  return page(v.title, `<h1>${esc(v.title)}</h1><p>${esc(v.body)}</p>`);
}
