import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { HTTP_METHODS, type HttpMethod, type RouteOperation } from './types';

// route-inventory: a STATIC, FAIL-CLOSED reading of src/app/api/partner/v1.
// Anything it does not understand throws InventoryError, so the drift test goes
// red instead of silently skipping an operation. Never imported by app code.
//
// An operation's "error codes" are the HTTP statuses it can return (Partner API
// errors carry no machine code, only { error: string }):
//   guard   — guardPartner / authenticatePartnerKey (401, 403, 429)
//   service — every literal err(<status>) / ok(<status>) in the one
//             partner-api-service function the handler calls (a status passed
//             through from any other function fails closed)
//   direct  — NextResponse / Response built in the handler (implicit 200 or a
//             literal `status:`)

export class InventoryError extends Error {}
export const GUARD_STATUSES: readonly number[] = [401, 403, 429];

const V1 = ['src', 'app', 'api', 'partner', 'v1'];
const SERVICE = ['src', 'lib', 'partner-api-service.ts'];

export interface ParsedHandler {
  method: HttpMethod;
  scope: string;
  serviceFn: string | null;
  /** The handler maps the service result through svcResponse (so every return must be err/ok). */
  viaSvc: boolean;
  directStatuses: number[];
}

/** Drop // and /* *\/ comments (full-line, trailing ` // …`, and blocks) before a structural scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/\s.*$/gm, '');
}

/** The text of a top-level function from `start` to its column-0 closing brace (or end of source). */
function topLevelSpan(src: string, start: number): string {
  const rest = src.slice(start);
  const firstLineEnd = rest.indexOf('\n');
  if (firstLineEnd < 0) return rest;
  // The span ends at the first column-0 `}`, or at the next top-level function or
  // arrow of ANY kind (exported or not), whichever comes first.
  const end = /^\}|^(?:export\s+)?(?:async\s+)?function\b|^(?:export\s+)?const\s+\w+\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:<[^>\n]*>\s*)?(?:\([^)\n]*\)|\w+)\s*(?::[^=\n]+)?=>/m
    .exec(rest.slice(firstLineEnd + 1));
  return end ? rest.slice(0, firstLineEnd + 1 + end.index + (end[0] === '}' ? 1 : 0)) : rest;
}

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listRouteFiles(p));
    else if (/^route\.[a-z]+$/.test(name)) {
      // Any route.* Next accepts (js/jsx/ts/tsx) is read; an extension this
      // analyzer cannot parse fails closed instead of being skipped.
      if (!/^route\.(ts|tsx|js|jsx)$/.test(name)) throw new InventoryError(`${p}: unsupported route file extension`);
      out.push(p);
    }
  }
  return out.sort();
}

export function routePathFromFile(v1Root: string, file: string): string {
  const rel = relative(v1Root, file).split(sep).slice(0, -1); // drop route.ts
  return '/' + rel.map((seg) => seg.replace(/^\[(\w+)\]$/, '{$1}')).join('/');
}

function importedServiceFns(src: string): string[] {
  const m = /import\s*\{([^}]+)\}\s*from\s*'@\/lib\/partner-api-service'/.exec(src);
  if (!m) return [];
  return m[1].split(',').map((s) => s.replace(/\btype\b/, '').trim()).filter(Boolean);
}

export function parseRouteSource(src: string, file: string): ParsedHandler[] {
  const M = '(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)';
  if (new RegExp(`export\\s+(const|let|var)\\s+${M}\\b`).test(src)) {
    throw new InventoryError(`${file}: handlers must be 'export async function <METHOD>' (found export const)`);
  }
  // Forms the head regex below cannot see must fail closed, not vanish.
  if (new RegExp(`export\\s+function\\s+${M}\\b`).test(src)) {
    throw new InventoryError(`${file}: handlers must be async ('export async function <METHOD>')`);
  }
  if (new RegExp(`export\\s*\\{[^}]*\\b${M}\\b[^}]*\\}`).test(src) || /export\s+default\b/.test(src)) {
    throw new InventoryError(`${file}: re-exported or default-exported handlers are not supported`);
  }
  const heads = [...src.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g)];
  if (heads.length === 0) throw new InventoryError(`${file}: no exported handler`);
  // Code before the first handler is imports and constants only: a helper there
  // could build a response (or a status) the per-handler scan never sees.
  const preamble = stripComments(src.slice(0, heads[0].index));
  if (/\bfunction\b|=>|\w*Response\s*[.(]|\bnew\s+\w*Response\b/.test(preamble)) {
    throw new InventoryError(`${file}: no helper function or response may be declared before the first handler`);
  }
  const fns = importedServiceFns(src);
  return heads.map((h, i) => {
    const method = h[1] as HttpMethod;
    if (!HTTP_METHODS.includes(method)) throw new InventoryError(`${file}: unknown export ${h[1]}`);
    const block = src.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : src.length);
    const guards = [...block.matchAll(/guardPartner\(\s*req\s*,\s*([^)]*)\)/g)];
    if (guards.length !== 1) throw new InventoryError(`${file} ${method}: expected exactly one guardPartner(req, '<scope>')`);
    const lit = /^'([a-z:]+)'$/.exec(guards[0][1].trim());
    if (!lit) throw new InventoryError(`${file} ${method}: guardPartner scope must be a string literal`);
    const called = fns.filter((f) => new RegExp(`\\b${f}\\(`).test(block));
    if (/\.(?:redirect|rewrite)\(|\bResponse\.error\(/.test(stripComments(block))) {
      throw new InventoryError(`${file} ${method}: redirect / rewrite / Response.error responses are not supported`);
    }
    const usesSvc = /\bsvcResponse\(/.test(block);
    // Plain Response / Response.json count as direct responses too.
    const usesDirect = /\b(?:Next)?Response\.json\(|\bnew\s+(?:Next)?Response\(/.test(block);
    if (usesSvc && called.length !== 1) {
      throw new InventoryError(`${file} ${method}: svcResponse must wrap exactly one partner-api-service call (found ${called.length})`);
    }
    if (!usesSvc && !usesDirect) throw new InventoryError(`${file} ${method}: no response path recognised`);
    const directStatuses: number[] = [];
    // Scan EVERY `status:` literal in the block (not only when usesDirect), so a
    // direct response beside svcResponse can never add an undocumented status.
    for (const s of block.matchAll(/status:\s*([^,}\s]+)/g)) {
      if (!/^\d{3}$/.test(s[1])) throw new InventoryError(`${file} ${method}: non-literal status '${s[1]}'`);
      directStatuses.push(Number(s[1]));
    }
    if (usesDirect && directStatuses.length === 0) directStatuses.push(200); // NextResponse.json default
    return {
      method,
      scope: lit[1],
      serviceFn: called.length === 1 ? called[0] : null,
      viaSvc: usesSvc,
      directStatuses: [...new Set(directStatuses)].sort((a, b) => a - b),
    };
  });
}

/**
 * The literal err()/ok() statuses of one exported service function. The span
 * ends at the function's column-0 closing brace or the next top-level function
 * or arrow (exported or not), so a helper that follows is never counted.
 *
 * `strict` (the default, used whenever the route maps the result through
 * svcResponse): every `return` in the span must be `return err(`, `return ok(`
 * or a bare `return;`. Returning anything else (a helper's result, another
 * service call, a variable) could pass through a status this scan never sees,
 * so it FAILS CLOSED instead of under-counting.
 */
export function serviceFunctionStatuses(
  serviceSrc: string,
  fn: string,
  opts: { strict?: boolean } = {},
): number[] {
  const strict = opts.strict ?? true;
  const heads = [...serviceSrc.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)];
  const head = heads.find((h) => h[1] === fn);
  if (!head) throw new InventoryError(`partner-api-service: function ${fn} not found`);
  const body = stripComments(topLevelSpan(serviceSrc, head.index));
  if (strict) {
    for (const r of body.matchAll(/\breturn\b(?!\s*(?:err|ok)\()(?!\s*;)[^\n]*/g)) {
      throw new InventoryError(`partner-api-service ${fn}: only 'return err(', 'return ok(' or 'return;' can be inventoried (found '${r[0].trim()}')`);
    }
  }
  const out = new Set<number>();
  for (const m of body.matchAll(/\b(?:err|ok)\(\s*([^,)]+)/g)) {
    if (!/^\d{3}$/.test(m[1].trim())) throw new InventoryError(`partner-api-service ${fn}: non-literal status '${m[1].trim()}'`);
    out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The statuses guardPartner (partner-api.ts) and authenticatePartner
 * (partner-api-auth.ts) can return. Inside guardPartner every `status:` must be
 * a 3-digit literal or the `auth.status` pass-through (whose values are the
 * auth file's literals); in the auth file every `status:` must be a literal or
 * the `status: number` type annotation. Anything else fails closed.
 */
export function guardStatusesFromSource(guardSrc: string, authSrc: string): number[] {
  const out = new Set<number>();
  const g = /^export\s+async\s+function\s+guardPartner\b/m.exec(guardSrc);
  if (!g) throw new InventoryError('partner-api: guardPartner not found');
  for (const m of stripComments(topLevelSpan(guardSrc, g.index)).matchAll(/status:\s*([^,}\s;]+)/g)) {
    if (/^\d{3}$/.test(m[1])) out.add(Number(m[1]));
    else if (m[1] !== 'auth.status') throw new InventoryError(`partner-api guardPartner: non-literal status '${m[1]}'`);
  }
  for (const m of stripComments(authSrc).matchAll(/status:\s*([^,}\s;]+)/g)) {
    if (/^\d{3}$/.test(m[1])) out.add(Number(m[1]));
    else if (m[1] !== 'number') throw new InventoryError(`partner-api-auth: non-literal status '${m[1]}'`);
  }
  return [...out].sort((a, b) => a - b);
}

export function inventoryPartnerRoutes(repoRoot: string = process.cwd()): RouteOperation[] {
  const v1Root = join(repoRoot, ...V1);
  const serviceSrc = readFileSync(join(repoRoot, ...SERVICE), 'utf8');
  const ops: RouteOperation[] = [];
  for (const file of listRouteFiles(v1Root)) {
    const path = routePathFromFile(v1Root, file);
    for (const h of parseRouteSource(readFileSync(file, 'utf8'), file)) {
      const svc = h.serviceFn ? serviceFunctionStatuses(serviceSrc, h.serviceFn, { strict: h.viaSvc }) : [];
      const statuses = [...new Set([...GUARD_STATUSES, ...svc, ...h.directStatuses])].sort((a, b) => a - b);
      ops.push({ path, method: h.method, scope: h.scope, statuses });
    }
  }
  return ops;
}
