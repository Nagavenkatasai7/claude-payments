// Program Ledger: GitHub reads for the sync engine (read-only, via curl; Node built-ins only).
// Moved from sync.mjs unchanged in behaviour.
//
// Auth: the auth header goes to curl through stdin (-K -), never argv or output. A token is used
// only when `gh auth token` gives one (locally). In the cloud routine `gh` is missing, so no
// header is sent and the egress proxy authenticates curl. LEDGER_GH_AUTH=none|gh forces a mode.
// Runs are read with event=push: a workflow_dispatch Smoke's head_sha is the dispatching branch's
// head, not the commit under test, so only push runs prove what production serves.
import { spawnSync } from 'node:child_process';
import { REPO } from './sync-core.mjs';

/**
 * The GitHub token from `gh auth token`, or null (no header is sent). LEDGER_GH_AUTH=none skips
 * gh; LEDGER_GH_AUTH=gh requires a token and throws (exitCode 2) when there is none.
 * @returns {string|null}
 */
export function ghToken() {
  const mode = process.env.LEDGER_GH_AUTH || 'auto';
  if (mode === 'none') return null;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
  const token = !r.error && r.status === 0 ? r.stdout.trim() : '';
  if (token) return token;
  if (mode === 'gh') throw Object.assign(new Error('LEDGER_GH_AUTH=gh but `gh auth token` returned no token'), { exitCode: 2 });
  return null;
}

/**
 * GET https://api.github.com<path> with curl; throws on a curl error or a non-2xx status.
 * @param {string} path
 * @param {string|null} token
 * @returns {any} the parsed JSON body
 */
export function ghGet(path, token) {
  const args = [
    '-sS', '--max-time', '30', '--retry', '2',
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '-H', 'User-Agent: smartremit-ledger-sync',
    '-w', '\n%{http_code}',
  ];
  if (token) args.push('-K', '-'); // the Authorization header arrives on stdin, never in argv
  args.push(`https://api.github.com${path}`);
  const r = spawnSync('curl', args, {
    encoding: 'utf8',
    input: token ? `header = "Authorization: Bearer ${token}"\n` : '',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  if (r.error) throw new Error(`curl could not run for GET ${path}: ${r.error.code || 'error'}`);
  const out = r.stdout || '';
  const nl = out.lastIndexOf('\n');
  const status = Number(out.slice(nl + 1));
  const body = nl >= 0 ? out.slice(0, nl) : '';
  if (r.status !== 0 || !(status >= 200 && status < 300)) {
    let message = '';
    try { message = String(JSON.parse(body).message || ''); } catch { /* not JSON */ }
    throw new Error(`GitHub GET ${path} failed: HTTP ${status || 'none'}${message ? ` (${message.slice(0, 120)})` : ''}${r.status ? `, curl exit ${r.status}` : ''}`);
  }
  return JSON.parse(body);
}

/**
 * Everything the engine reads from GitHub: main's sha7, recent PRs, open PRs, push CI and Smoke runs on main.
 * @returns {{auth: 'gh'|'none', mainSha: string, prs: any[], openPrs: any[], ciRuns: any[], smokeRuns: any[]}}
 */
export function fetchGitHub() {
  const token = ghToken();
  const get = (p) => ghGet(p, token);
  const head = get(`/repos/${REPO}/branches/main`).commit?.sha;
  if (!/^[0-9a-f]{40}$/.test(head || '')) throw new Error('GitHub returned no sha for main');
  return {
    auth: token ? 'gh' : 'none',
    mainSha: head.slice(0, 7),
    prs: get(`/repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=60`),
    openPrs: get(`/repos/${REPO}/pulls?state=open&per_page=100`),
    ciRuns: get(`/repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=20`).workflow_runs ?? [],
    smokeRuns: get(`/repos/${REPO}/actions/workflows/smoke.yml/runs?branch=main&event=push&per_page=30`).workflow_runs ?? [],
  };
}
