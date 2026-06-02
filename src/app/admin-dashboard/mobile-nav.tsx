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
      className="sh-hamburger"
      aria-label="Open navigation menu"
      aria-expanded={open}
      aria-controls="sh-mobile-drawer"
      onClick={toggle}
    >
      <span className="sh-hamburger-bars" aria-hidden="true">
        <span />
        <span />
        <span />
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
        className={`sh-drawer-backdrop ${open ? 'is-open' : ''}`}
        onClick={close}
        aria-hidden="true"
      />
      <div
        ref={drawerRef}
        id="sh-mobile-drawer"
        className={`sh-drawer ${open ? 'is-open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
      >
        <div className="sh-drawer-head">
          <span className="sh-drawer-title">Menu</span>
          <button
            type="button"
            className="sh-drawer-close"
            aria-label="Close navigation menu"
            onClick={close}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <nav className="sh-drawer-nav" aria-label="Dashboard">
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
                className={`sh-nav-item ${active ? 'active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <span className="sh-nav-icon">{it.icon}</span> {it.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}
