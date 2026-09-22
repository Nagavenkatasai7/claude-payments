import LazyVideo from './LazyVideo';

// The /about demo-video slot. HIDDEN until the owner approves a clip: the
// current cut is not approved (garbled on-screen text, and it says "credited
// from SmartRemit.ai"), so the constant ships null and the component renders
// nothing at all: no empty frame, no broken player, no client JS.
//
// To go live: drop the mp4 and its poster in public/brand/ and set, e.g.,
//   { src: '/brand/about-demo.mp4', poster: '/brand/about-demo-poster.jpg' }
// Same-origin files pass the enforced CSP: media-src 'self' (video) and
// img-src 'self' (poster) in next.config.ts.

export type AboutDemoVideoSource = { src: string; poster: string };

export const ABOUT_DEMO_VIDEO: AboutDemoVideoSource | null = null;

export default function AboutDemoVideo({
  video = ABOUT_DEMO_VIDEO,
}: {
  video?: AboutDemoVideoSource | null;
}) {
  if (!video) return null;
  return (
    <section className="px-5 pb-[clamp(40px,6vw,72px)]" aria-label="Product demo">
      <figure className="mx-auto flex w-full max-w-[1000px] flex-col items-center">
        {/* Phone-style frame, matching the landing hero's chat mock. */}
        <div className="w-full max-w-[300px] rounded-[46px] bg-[#0b1b3f] p-[9px] shadow-[0_30px_60px_-28px_rgba(11,27,63,0.5)]">
          <LazyVideo
            src={video.src}
            poster={video.poster}
            label="SmartRemit demo: one transfer in WhatsApp, start to finish"
            className="block aspect-[9/16] w-full rounded-[38px] bg-[#0b1b3f] object-cover"
          />
        </div>
        <figcaption className="mt-4 text-[14px] text-[#52607a]">
          One transfer, start to finish.
        </figcaption>
      </figure>
    </section>
  );
}
