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
        <li key={`grp-${item.group}`} role="presentation" className="sh-cmdk-group-label">
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
        className="sh-cmdk-option"
        onMouseMove={() => setActive(i)}
        onClick={() => go(item)}
      >
        <span className="sh-cmdk-option-icon">
          <Icon name={item.icon} />
        </span>
        <span className="sh-cmdk-option-label">{item.label}</span>
        {item.keywords?.includes('action') ? (
          <span className="sh-cmdk-option-hint">Action</span>
        ) : null}
      </li>,
    );
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="sh-search"
        aria-label="Search and commands"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={openPalette}
      >
        <span className="sh-cmdk-search-icon" aria-hidden="true" style={{ display: 'inline-flex' }}>
          <Icon name="search" />
        </span>
        <span className="sh-search-label">Search or jump to…</span>
        <span className="sh-kbd" aria-hidden="true">
          <Icon name="command" />K
        </span>
      </button>

      <dialog
        ref={dialogRef}
        className="sh-cmdk"
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
        <div className="sh-cmdk-input-row">
          <span className="sh-cmdk-search-icon" aria-hidden="true">
            <Icon name="search" />
          </span>
          <input
            autoFocus
            className="sh-cmdk-input"
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
        <ul ref={listRef} id="sh-cmdk-list" role="listbox" aria-label="Commands" className="sh-cmdk-list">
          {filtered.length === 0 ? (
            <li role="presentation" className="sh-cmdk-empty">
              No matches for “{query}”
            </li>
          ) : (
            rendered
          )}
        </ul>
        <div className="sh-cmdk-footer" aria-hidden="true">
          <span className="sh-cmdk-footer-hint">
            <span className="sh-kbd"><Icon name="enter" /></span> open
          </span>
          <span className="sh-cmdk-footer-hint">
            <span className="sh-kbd">esc</span> close
          </span>
        </div>
        <div aria-live="polite" className="sh-visually-hidden">
          {liveMsg}
        </div>
      </dialog>
    </>
  );
}
