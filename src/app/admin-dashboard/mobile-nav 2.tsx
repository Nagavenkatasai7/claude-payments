'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ResolvedNavItem } from './nav';
import { Icon } from './icons';

/**
 * Accessible off-canvas navigation for the admin dashboard on phones/tablets.
 *
 * The desktop <Sidebar> stays as-is (hidden by CSS below 1024px). On small
 * screens this drawer takes over: the hamburger lives in the top bar, the drawer
 * is a fixed overlay rendered at the layout root. They share open-state through a
 * context so the two live in different parts of the layout tree.
 *
 * Implements the WAI-ARIA dialog pattern: aria-expanded/aria-controls on the
 * trigger, role="dialog" + aria-modal on the panel, focus trap, Esc-to-close,
 * click-outside, body-scroll-lock, and focus return to the trigger on close.
 * Motion is gated by prefers-reduced-motion in CSS.
 */

interface DrawerCtx {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}

const Ctx = createContext<DrawerCtx | null>(null);

// Shared nav-item recipe — duplicated from sidebar.tsx (a server module this
// client component cannot import).
const navItemBase =
  'relative mb-px flex min-h-11 items-center gap-2.5 rounded-md px-[11px] py-2 text-[13px] font-medium transition-colors';
const navItemIdle = 'text-muted-foreground hover:bg-secondary hover:text-foreground';
const navItemActive =
  "bg-sidebar-accent font-semibold text-sidebar-accent-foreground before:absolute before:-left-3 before:top-1/2 before:h-[18px] before:w-[3px] before:-translate-y-1/2 before:rounded-r-[3px] before:bg-primary before:content-['']";

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  return <Ctx.Provider value={{ open, setOpen, toggle }}>{children}</Ctx.Provider>;
}

function useDrawer(): DrawerCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useDrawer must be used within a DrawerProvider');
  return c;
}

/** Hamburger trigger — rendered inside the top bar; visible only on mobile (CSS). */
export function MobileMenuButton() {
  const { open, toggle } = useDrawer();
  return (
    <button
      type="button"
      className="mr-1.5 inline-flex h-10 w-10 flex-none cursor-pointer items-center justify-center rounded-md border border-border bg-transparent text-foreground min-[1025px]:hidden"
      aria-label="Open navigation menu"
      aria-expanded={open}
      aria-controls="sh-mobile-drawer"
      onClick={toggle}
    >
      <span className="inline-flex w-[18px] flex-col gap-1" aria-hidden="true">
        <span className="block h-0.5 rounded-[2px] bg-current" />
        <span className="block h-0.5 rounded-[2px] bg-current" />
        <span className="block h-0.5 rounded-[2px] bg-current" />
      </span>
    </button>
  );
}

/** The off-canvas drawer + backdrop — rendered once at the layout root. */
export function MobileNavDrawer({ items }: { items: ResolvedNavItem[] }) {
  const { open, setOpen } = useDrawer();
  const pathname = usePathname();
  const drawerRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  const close = useCallback(() => setOpen(false), [setOpen]);

  useEffect(() => {
    if (!open) return;

    // Remember what had focus so we can restore it on close.
    restoreFocusTo.current = (document.activeElement as HTMLElement | null) ?? null;

    const drawer = drawerRef.current;
    const focusables = () =>
      drawer
        ? Array.from(
            drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
          )
        : [];

    // Move focus into the drawer.
    focusables()[0]?.focus();
    // Lock background scroll.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === 'Tab') {
        const f = focusables();
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      restoreFocusTo.current?.focus?.();
    };
  }, [open, close]);

  return (
    <>
      <div
        className={`fixed inset-0 z-[999] bg-[rgba(10,37,64,0.45)] motion-safe:transition-opacity motion-safe:duration-[250ms] motion-safe:ease-in-out min-[1025px]:hidden ${open ? 'is-open pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
        onClick={close}
        aria-hidden="true"
      />
      <div
        ref={drawerRef}
        id="sh-mobile-drawer"
        className={`fixed inset-y-0 left-0 z-[1000] flex w-[84%] max-w-[300px] flex-col overflow-y-auto bg-card text-foreground shadow-[2px_0_18px_rgba(10,37,64,0.18)] min-[1025px]:hidden ${
          open
            ? 'is-open visible translate-x-0 motion-safe:[transition:transform_.25s_ease]'
            : 'invisible -translate-x-full motion-safe:[transition:transform_.25s_ease,visibility_0s_linear_.25s]'
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
      >
        <div className="flex items-center justify-between border-b border-border pr-4 pb-3.5 pt-[max(14px,env(safe-area-inset-top))] pl-[max(16px,env(safe-area-inset-left))]">
          <span className="text-sm font-bold text-foreground">Menu</span>
          <button
            type="button"
            className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-md border border-border bg-transparent text-[15px] text-muted-foreground [&_svg]:block [&_svg]:h-4 [&_svg]:w-4"
            aria-label="Close navigation menu"
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </div>
        <nav
          className="flex flex-col gap-0.5 pt-2.5 pr-2.5 pb-[max(10px,calc(10px+env(safe-area-inset-bottom)))] pl-[max(10px,env(safe-area-inset-left))]"
          aria-label="Dashboard"
        >
          {items.map((it) => {
            const active =
              it.href === '/admin-dashboard'
                ? pathname === '/admin-dashboard'
                : pathname === it.href || pathname.startsWith(it.href + '/');
            return (
              <Link
                key={it.key}
                href={it.href}
                onClick={close}
                className={`${navItemBase} ${active ? navItemActive : navItemIdle}`}
                aria-current={active ? 'page' : undefined}
              >
                <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center opacity-90 [&_svg]:block [&_svg]:h-[17px] [&_svg]:w-[17px]"><Icon name={it.icon} /></span> {it.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}
