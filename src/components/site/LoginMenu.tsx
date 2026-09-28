'use client';
import * as React from 'react';
import { dsCn } from '@/lib/ui/ds-cn';
import { LOGIN_MENU_CLOSED, loginMenuReducer } from '@/lib/ui/login-menu';
import { LOGIN_MENU } from './site-links';

// The landing's "Log in" menu (src/app/page.tsx LoginMenu), rebuilt as a WAI-ARIA disclosure so
// it works from the keyboard: the trigger is a button with aria-expanded/aria-controls, Enter or
// Space toggles it, Escape closes it and returns focus, and focus or a click outside closes it.
// Mouse users still get the landing's hover-open. While closed, the panel is `invisible`, so
// its links stay out of the tab order. Every destination is a real link.
export function LoginMenu() {
  const [state, dispatch] = React.useReducer(loginMenuReducer, LOGIN_MENU_CLOSED);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelId = React.useId();

  React.useEffect(() => {
    if (!state.focusTrigger) return;
    triggerRef.current?.focus();
    dispatch({ type: 'focusHandled' });
  }, [state.focusTrigger]);

  React.useEffect(() => {
    if (!state.open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) dispatch({ type: 'pointerOutside' });
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [state.open]);

  const item = 'flex flex-col gap-0.5 rounded-xl px-3 py-2.5 transition-colors hover:bg-ds-tint';
  return (
    <div
      ref={rootRef}
      className="group relative max-[760px]:hidden"
      onKeyDown={(e) => {
        if (e.key === 'Escape') dispatch({ type: 'escape' });
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) dispatch({ type: 'focusOutside' });
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 bg-transparent text-[14px] text-ds-ink-muted transition-colors hover:text-ds-ink"
        aria-expanded={state.open}
        aria-controls={panelId}
        onClick={() => dispatch({ type: 'toggle' })}
      >
        Log in
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={dsCn('transition-transform duration-150 motion-reduce:transition-none', state.open && 'rotate-180')}
        >
          <path d="M2 3.5l3 3 3-3" />
        </svg>
      </button>
      <div
        id={panelId}
        className={dsCn(
          'absolute right-0 top-full z-50 pt-2',
          // Fade in on open; hide at once on close. A visibility transition on close would leave
          // the links focusable for its duration, so a Tab right after Escape would land inside.
          state.open
            ? 'visible opacity-100 transition-[opacity,visibility] duration-150 motion-reduce:transition-none'
            : 'invisible opacity-0 group-hover:visible group-hover:opacity-100 group-hover:transition-[opacity,visibility] group-hover:duration-150 motion-reduce:group-hover:transition-none',
        )}
      >
        <div className="w-64 rounded-2xl border border-ds-border bg-ds-surface p-1.5 shadow-ds-pop">
          {LOGIN_MENU.map((l) => (
            <a key={l.href} className={item} href={l.href}>
              <span className="text-[14px] font-semibold text-ds-ink">{l.title}</span>
              <span className="text-[12px] text-ds-ink-muted">{l.sub}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
