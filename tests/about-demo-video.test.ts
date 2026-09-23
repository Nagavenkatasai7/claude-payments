import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AboutDemoVideo, { ABOUT_DEMO_VIDEO, type AboutDemoVideoSource } from '@/app/about/AboutDemoVideo';

// The /about demo-video slot stays HIDDEN until the owner approves a clip:
// with no source it must render nothing at all (no empty frame, no broken
// player). With a source it renders a vertical, muted, inline, looping player
// whose file is attached lazily (data-src until it nears the viewport).

describe('AboutDemoVideo', () => {
  it('ships unset, so /about shows no video', () => {
    expect(ABOUT_DEMO_VIDEO).toBeNull();
    expect(renderToStaticMarkup(createElement(AboutDemoVideo))).toBe('');
  });

  it('renders nothing for an explicit null source', () => {
    expect(renderToStaticMarkup(createElement(AboutDemoVideo, { video: null }))).toBe('');
  });

  it('renders a muted, inline, looping, autoplaying 9:16 player with controls and a poster when set', () => {
    const html = renderToStaticMarkup(
      createElement(AboutDemoVideo, {
        video: { src: '/brand/about-demo.mp4', poster: '/brand/about-demo-poster.jpg' },
      }),
    );
    const tag = html.match(/<video\b[^>]*>/)?.[0] ?? '';
    expect(tag).not.toBe('');
    for (const attr of ['muted', 'playsInline', 'loop', 'autoPlay', 'controls']) {
      expect(tag).toMatch(new RegExp(`\\s${attr}=""`));
    }
    expect(tag).toContain('preload="metadata"');
    expect(tag).toContain('poster="/brand/about-demo-poster.jpg"');
    expect(tag).toMatch(/aria-label="[^"]+"/);
    expect(tag).toContain('aspect-[9/16]');
    // Lazy: the file is not in the server markup's src, only in data-src.
    expect(tag).toContain('data-src="/brand/about-demo.mp4"');
    expect(tag).not.toMatch(/\ssrc="/);
  });
});

// Program-Fix 41 (ui-02 fallback): the first cut shipped pointing at a file
// that was never deployed (/about-demo.mp4 answered 404). Once the owner's clip
// is slotted in, both of its files must exist under public/, or this fails.
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

/** The slot's files that are NOT same-origin files under public/. */
function missingPublicFiles(video: AboutDemoVideoSource | null): string[] {
  if (!video) return [];
  return [video.src, video.poster].filter(
    (path) => !path.startsWith('/') || path.includes('..') || !existsSync(PUBLIC_DIR + path.slice(1)),
  );
}

describe('AboutDemoVideo files exist', () => {
  it('the shipped slot points only at files under public/ (vacuous while null)', () => {
    expect(missingPublicFiles(ABOUT_DEMO_VIDEO)).toEqual([]);
  });

  it('the guard catches a slot whose files are not in public/', () => {
    expect(
      missingPublicFiles({ src: '/brand/nope.mp4', poster: '/brand/nope-poster.jpg' }),
    ).toEqual(['/brand/nope.mp4', '/brand/nope-poster.jpg']);
    expect(
      missingPublicFiles({ src: 'https://example.com/clip.mp4', poster: '/brand/og-image.png' }),
    ).toEqual(['https://example.com/clip.mp4']);
  });

  it('the guard passes a slot whose files do exist', () => {
    expect(
      missingPublicFiles({ src: '/brand/og-image.png', poster: '/brand/og-image.png' }),
    ).toEqual([]);
  });
});
