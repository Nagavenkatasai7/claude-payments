#!/usr/bin/env node
/**
 * UI redesign M4 PR-3: fail CI when `next build` changes the rendering mode of an existing
 * route. The @next/mdx wrap in next.config.ts touches the build for EVERY route, so the
 * `build` job in ci.yml runs this right after `npm run build`:
 *
 *   node scripts/check-route-modes.mjs           compare .next with the committed baseline
 *   node scripts/check-route-modes.mjs --write   refresh scripts/route-modes.baseline.json
 *
 * A route in the baseline that disappears or changes mode (static / ssg / dynamic) fails.
 * A NEW route passes and is listed; the PR that adds it refreshes the baseline with --write.
 * Inputs: .next/app-path-routes-manifest.json (every app route) and
 * .next/prerender-manifest.json (what was prerendered), as written by Next 16.3.5.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BASELINE = 'scripts/route-modes.baseline.json';

/**
 * @param {{ appPathRoutes: Record<string, string>, prerender: { routes: Record<string, { srcRoute?: string | null }>, dynamicRoutes: Record<string, unknown> } }} m
 * @returns {Record<string, 'static' | 'ssg' | 'dynamic'>} route -> mode, sorted by route
 */
export function routeModes({ appPathRoutes, prerender }) {
  const prerendered = new Set();
  for (const [path, r] of Object.entries(prerender.routes)) prerendered.add(r.srcRoute ?? path);
  /** @type {Record<string, 'static' | 'ssg' | 'dynamic'>} */
  const out = {};
  for (const route of [...new Set(Object.values(appPathRoutes))].sort()) {
    out[route] = Object.hasOwn(prerender.dynamicRoutes, route) ? 'ssg' : prerendered.has(route) ? 'static' : 'dynamic';
  }
  return out;
}

/**
 * @param {Record<string, string>} baseline
 * @param {Record<string, string>} current
 * @returns {{ problems: string[], added: string[] }}
 */
export function compareRouteModes(baseline, current) {
  const problems = [];
  for (const [route, mode] of Object.entries(baseline)) {
    const now = Object.hasOwn(current, route) ? current[route] : 'missing';
    if (now !== mode) problems.push(`${route}: ${mode} -> ${now}`);
  }
  const added = Object.keys(current)
    .filter((r) => !Object.hasOwn(baseline, r))
    .map((r) => `${r} ${current[r]}`);
  return { problems, added };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const read = (/** @type {string} */ f) => JSON.parse(readFileSync(f, 'utf8'));
  const current = routeModes({
    appPathRoutes: read('.next/app-path-routes-manifest.json'),
    prerender: read('.next/prerender-manifest.json'),
  });
  if (process.argv.includes('--write')) {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`check-route-modes: wrote ${Object.keys(current).length} routes to ${BASELINE}.`);
    process.exit(0);
  }
  const { problems, added } = compareRouteModes(read(BASELINE), current);
  for (const a of added) console.log(`check-route-modes: new route (refresh the baseline with --write): ${a}`);
  if (problems.length > 0) {
    console.error(`check-route-modes: ${problems.length} route(s) changed rendering mode or disappeared:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`check-route-modes: all ${Object.keys(read(BASELINE)).length} baseline routes kept their rendering mode.`);
}
