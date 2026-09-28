import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { routeModes, compareRouteModes } from '../scripts/check-route-modes.mjs';

// UI redesign M4 PR-3 wraps next.config.ts with @next/mdx, which changes the build for EVERY
// route. scripts/check-route-modes.mjs runs after `next build` in CI and fails when any route
// in the committed baseline disappears or changes rendering mode (static / ssg / dynamic).
// New routes are allowed (other work adds routes); they are listed, and the baseline is
// refreshed with `node scripts/check-route-modes.mjs --write` in the PR that adds them.
// Manifest shapes read from a real `next build` (.next/prerender-manifest.json,
// .next/app-path-routes-manifest.json; Next 16.3.5).

const appPathRoutes = {
  '/_not-found/page': '/_not-found',
  '/about/page': '/about',
  '/account/page': '/account',
  '/api/version/route': '/api/version',
  '/robots.txt/route': '/robots.txt',
  '/guides/[slug]/page': '/guides/[slug]',
};
const prerender = {
  version: 4,
  routes: {
    '/_not-found': { srcRoute: '/_not-found' },
    '/about': { srcRoute: '/about' },
    '/robots.txt': { srcRoute: '/robots.txt' },
    '/guides/a': { srcRoute: '/guides/[slug]' },
  },
  dynamicRoutes: { '/guides/[slug]': { fallback: false } },
  notFoundRoutes: [],
};

describe('routeModes', () => {
  it('classifies every app route as static, ssg or dynamic, sorted', () => {
    expect(routeModes({ appPathRoutes, prerender })).toEqual({
      '/_not-found': 'static',
      '/about': 'static',
      '/account': 'dynamic',
      '/api/version': 'dynamic',
      '/guides/[slug]': 'ssg',
      '/robots.txt': 'static',
    });
    expect(Object.keys(routeModes({ appPathRoutes, prerender }))).toEqual(
      Object.keys(routeModes({ appPathRoutes, prerender })).sort(),
    );
  });
});

describe('compareRouteModes', () => {
  const base = { '/a': 'static', '/b': 'dynamic', '/c': 'ssg' };
  it('passes when nothing changed', () => {
    expect(compareRouteModes(base, { ...base })).toEqual({ problems: [], added: [] });
  });
  it('allows and lists new routes', () => {
    expect(compareRouteModes(base, { ...base, '/new': 'static' })).toEqual({ problems: [], added: ['/new static'] });
  });
  it('fails when a baseline route changed mode or disappeared', () => {
    const { problems } = compareRouteModes(base, { '/a': 'dynamic', '/c': 'ssg' });
    expect(problems).toEqual(['/a: static -> dynamic', '/b: dynamic -> missing']);
  });
});

describe('the committed baseline', () => {
  it('covers the app (the landing, /docs, the partner API)', () => {
    const b = JSON.parse(readFileSync('scripts/route-modes.baseline.json', 'utf8')) as Record<string, string>;
    expect(Object.keys(b).length).toBeGreaterThan(80);
    expect(b['/']).toBe('dynamic');
    expect(b['/docs']).toBe('static');
    expect(b['/api/partner/v1/quote']).toBe('dynamic');
  });
});
