import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AboutDemoVideo, { ABOUT_DEMO_VIDEO } from '@/app/about/AboutDemoVideo';

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
