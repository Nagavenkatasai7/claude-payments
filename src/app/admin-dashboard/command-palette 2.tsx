'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icons';
import type { CommandItem } from './command-items';

/**
 * Cmd-K command palette for the admin dashboard.
 *
 * A combobox (the input) whose popup is a listbox (the results), rendered inside
 * a native <dialog> (which gives us focus-trap, Esc-to-close, ::backdrop, and
 * focus-return to the invoker for free). Per the WAI-ARIA APG combobox pattern
 * we use the **aria-activedescendant** model: DOM focus stays on the input so the
 * user keeps typing, while the AT focus moves through options via
 * `aria-activedescendant`; we manually scroll the active option into view (the
 * browser won't for activedescendant). A debounced `aria-live` region announces
 * the result count — the documented APG gap.
 *
 * This component renders BOTH the top-bar trigger button (the "search" field) and
 * the dialog, so it is fully self-contained. All commands are navigations
 * (`router.push`) — no server calls in v1.
 */

/** Keyboard-hint chip (⌘K, ↵, esc). Display is set per call site (the trigger's
 *  chip hides at ≤1024px), so this recipe deliberately omits it. */
const KBD =
  'flex-none items-center gap-px rounded-sm border border-border bg-card px-[5px] py-px text-[11px] leading-normal font-semibold text-muted-foreground [&_svg]:block [&_svg]:h-3 [&_svg]:w-3';

function matches(item: CommandItem, q: string): boolean {
  if (!q) return true;
  const hay = `${item.label} ${item.group} ${item.keywords ?? ''}`.toLowerCase();
  // every whitespace-separated term must appear (AND match)
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

export function CommandPalette({ items }: { items: CommandItem[] }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [liveMsg, setLiveMsg] = useState('');

  const filtered = useMemo(
    () => items.filter((it) => matches(it, query)),
    [items, query],
  );
  // Derive (don't store) the clamped active index so a shrinking result set can
  // never leave `active` out of range — avoids a setState-in-effect.
  const activeIndex = filtered.length === 0 ? 0 : Math.min(active, filtered.length - 1);

  const openPalette = useCallback(() => {
    setQuery('');
    setActive(0);
    setOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    // Native close() triggers onClose, which syncs `open`.
    dialogRef.current?.close();
  }, []);

  // Drive the native dialog from React state.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  // Global Cmd/Ctrl-K to toggle the palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((o) => {
          if (o) {
            dialogRef.current?.close();
            return false;
          }
          setQuery('');
          setActive(0);
          return true;
        });
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Debounced screen-reader result-count announcement (APG gap).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      setLiveMsg(
        filtered.length === 0
          ? 'No results'
          : `${filtered.length} result${filtered.length === 1 ? '' : 's'} available`,
      );
    }, 200);
    return () => clearTimeout(t);
  }, [filtered.length, open, query]);

  // Scroll the active option into view (activedescendant doesn't auto-scroll).
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`#sh-cmdk-opt-${activeIndex}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  function go(item: CommandItem | undefined) {
    if (!item) return;
    closePalette();
    router.push(item.href);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(filtered.length ? (activeIndex + 1) % filtered.length : 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(filtered.length ? (activeIndex - 1 + filtered.length) % filtered.length : 0);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(Math.max(0, filtered.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(filtered[activeIndex]);
    }
    // Escape is handled by the native <dialog> (cancel → close).
  }

  // Build the rendered list with group headers interleaved, tracking flat index.
  const rendered: React.ReactNode[] = [];
  let lastGroup = '';
  filtered.forEach((item, i) => {
    if (item.group !== lastGroup) {
      lastGroup = item.group;
      rendered.push(
        <li
          key={`grp-${item.group}`}
          role="presentation"
          className="px-2.5 pt-2 pb-1 text-[10.5px] font-semibold tracking-[0.5px] text-muted-foreground uppercase"
        >
          {item.group}
        </li>,
      );
    }
    rendered.push(
      <li
        key={item.id}
        id={`sh-cmdk-opt-${i}`}
        role="option"
        aria-selected={i === activeIndex}
        className="group flex cursor-pointer scroll-m-2 items-center gap-[11px] rounded-md px-2.5 py-[9px] text-[13.5px] text-foreground aria-selected:bg-accent aria-selected:text-accent-foreground"
        onMouseMove={() => setActive(i)}
        onClick={() => go(item)}
      >
        <span className="inline-flex h-[18px] w-[18px] flex-none items-center justify-center text-muted-foreground group-aria-selected:text-primary [&_svg]:block [&_svg]:h-[17px] [&_svg]:w-[17px]">
          <Icon name={item.icon} />
        </span>
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.keywords?.includes('action') ? (
          <span className="flex-none text-[11px] text-muted-foreground">Action</span>
        ) : null}
      </li>,
    );
  });

  return (
    <>
      {/* Top-bar trigger: a full "search field" on desktop, collapses to a
          40px icon button at ≤1024px (Cmd-K stays reachable on touch). */}
      <button
        ref={triggerRef}
        type="button"
        className="ml-0.5 flex h-9 w-10 flex-none cursor-text items-center justify-center gap-2 rounded-lg border border-border bg-background text-left text-[13px] text-muted-foreground transition-colors hover:border-input hover:bg-card min-[1025px]:mr-auto min-[1025px]:ml-2 min-[1025px]:w-auto min-[1025px]:max-w-[420px] min-[1025px]:flex-auto min-[1025px]:justify-start min-[1025px]:pr-2.5 min-[1025px]:pl-3"
        aria-label="Search and commands"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={openPalette}
      >
        <span className="inline-flex [&_svg]:block [&_svg]:h-[17px] [&_svg]:w-[17px]" aria-hidden="true">
          <Icon name="search" />
        </span>
        <span className="hidden min-w-0 flex-1 truncate min-[1025px]:block">Search or jump to…</span>
        <span className={`hidden min-[1025px]:inline-flex ${KBD}`} aria-hidden="true">
          <Icon name="command" />K
        </span>
      </button>

      <dialog
        ref={dialogRef}
        className="mx-auto mt-[12vh] mb-auto w-[min(92vw,560px)] max-w-[560px] overflow-hidden rounded-xl border-none bg-popover p-0 text-foreground shadow-[0_0_0_1px_rgba(16,24,40,0.04),0_24px_48px_-12px_rgba(16,24,40,0.18)] backdrop:bg-[rgba(16,24,40,0.45)] backdrop:backdrop-blur-[1px]"
        aria-label="Command palette"
        onClose={() => {
          setOpen(false);
          setQuery('');
        }}
        onClick={(e) => {
          // Click on the backdrop (the dialog element itself) closes it.
          if (e.target === dialogRef.current) closePalette();
        }}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <span className="inline-flex flex-none text-muted-foreground [&_svg]:block [&_svg]:h-[18px] [&_svg]:w-[18px]" aria-hidden="true">
            <Icon name="search" />
          </span>
          <input
            autoFocus
            className="flex-1 border-none bg-transparent py-0.5 text-base text-foreground outline-none placeholder:text-muted-foreground"
            role="combobox"
            aria-expanded="true"
            aria-controls="sh-cmdk-list"
            aria-autocomplete="list"
            aria-activedescendant={filtered.length ? `sh-cmdk-opt-${activeIndex}` : undefined}
            aria-label="Search commands and pages"
            placeholder="Search pages and actions…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
          />
        </div>
        <ul
          ref={listRef}
          id="sh-cmdk-list"
          role="listbox"
          aria-label="Commands"
          className="m-0 max-h-[52vh] list-none overflow-y-auto p-1.5"
        >
          {filtered.length === 0 ? (
            <li role="presentation" className="px-4 py-7 text-center text-[13px] text-muted-foreground">
              No matches for “{query}”
            </li>
          ) : (
            rendered
          )}
        </ul>
        <div
          className="flex items-center gap-3.5 border-t border-border bg-background px-4 py-[9px] text-[11px] text-muted-foreground"
          aria-hidden="true"
        >
          <span className="inline-flex items-center gap-[5px]">
            <span className={`inline-flex ${KBD}`}><Icon name="enter" /></span> open
          </span>
          <span className="inline-flex items-center gap-[5px]">
            <span className={`inline-flex ${KBD}`}>esc</span> close
          </span>
        </div>
        <div aria-live="polite" className="sr-only">
          {liveMsg}
        </div>
      </dialog>
    </>
  );
}
