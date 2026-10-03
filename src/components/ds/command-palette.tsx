'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CornerDownLeft, Search } from 'lucide-react';
import { matchesCommand } from '@/lib/command-match';

export interface CommandPaletteItem {
  id: string;
  href: string;
  label: string;
  group: string;
  /** Extra search terms (not displayed). */
  keywords?: string;
}

export interface CommandPaletteLabels {
  trigger: string;
  label: string;
  placeholder: string;
  /** "No matches for …"; receives the query. */
  empty: (query: string) => string;
  /** The polite result-count announcement. */
  results: (count: number) => string;
  hintOpen: string;
  hintClose: string;
}

const KBD =
  'inline-flex flex-none items-center gap-px rounded-[4px] border border-ds-border bg-ds-surface px-[5px] py-px text-[11px] leading-normal font-semibold text-ds-ink-muted';

/**
 * A Ctrl/Cmd-K command palette on ds tokens (lost-features A16; the behaviour of the legacy
 * /admin-dashboard palette). A combobox (the input) whose popup is a listbox, inside a native
 * <dialog> (focus trap, Esc to close, ::backdrop and focus return to the trigger). WAI-ARIA APG
 * combobox with aria-activedescendant: DOM focus stays on the input while the active option moves;
 * the active option is scrolled into view by hand, and a debounced aria-live region announces the
 * result count. Every command is a navigation; the target page re-gates. `extraFor` adds items built
 * from the query (shown first, never filtered by it). All copy arrives in `labels`.
 */
export function CommandPalette({
  items,
  labels,
  extraFor,
}: {
  items: CommandPaletteItem[];
  labels: CommandPaletteLabels;
  extraFor?: (query: string) => CommandPaletteItem[];
}) {
  const router = useRouter();
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const [liveMsg, setLiveMsg] = React.useState('');
  const baseId = React.useId();
  const listId = `${baseId}-list`;
  const optId = React.useCallback((i: number) => `${baseId}-opt-${i}`, [baseId]);

  const filtered = React.useMemo(
    () => [...(extraFor ? extraFor(query) : []), ...items.filter((it) => matchesCommand(it, query))],
    [items, query, extraFor],
  );
  // Derived, so a shrinking result set never leaves the active index out of range.
  const activeIndex = filtered.length === 0 ? 0 : Math.min(active, filtered.length - 1);

  const closePalette = React.useCallback(() => dialogRef.current?.close(), []);

  React.useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setQuery('');
        setActive(0);
        setOpen((o) => !o);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => setLiveMsg(labels.results(filtered.length)), 200);
    return () => clearTimeout(timer);
  }, [filtered.length, open, query, labels]);

  React.useEffect(() => {
    if (!open) return;
    // By id, not a CSS selector: useId values hold ':' characters.
    document.getElementById(optId(activeIndex))?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open, optId]);

  function go(item: CommandPaletteItem | undefined) {
    if (!item) return;
    closePalette();
    router.push(item.href);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const n = filtered.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(n ? (activeIndex + 1) % n : 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(n ? (activeIndex - 1 + n) % n : 0);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(Math.max(0, n - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(filtered[activeIndex]);
    }
    // Escape: the native <dialog> cancels and closes.
  }

  const rendered: React.ReactNode[] = [];
  let lastGroup = '';
  filtered.forEach((item, i) => {
    if (item.group !== lastGroup) {
      lastGroup = item.group;
      rendered.push(
        <li key={`grp-${item.group}`} role="presentation" className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-[0.04em] text-ds-ink-subtle uppercase">
          {item.group}
        </li>,
      );
    }
    rendered.push(
      <li
        key={item.id}
        id={optId(i)}
        role="option"
        aria-selected={i === activeIndex}
        className="group flex min-h-11 cursor-pointer scroll-m-2 items-center gap-3 rounded-ds-inner px-2.5 py-2 text-[14.5px] text-ds-ink aria-selected:bg-ds-tint aria-selected:text-ds-primary"
        onMouseMove={() => setActive(i)}
        onClick={() => go(item)}
      >
        <ArrowRight aria-hidden="true" className="size-4 flex-none text-ds-ink-subtle group-aria-selected:text-ds-primary" />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      </li>,
    );
  });

  return (
    <>
      <button
        type="button"
        aria-label={labels.label}
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => {
          setQuery('');
          setActive(0);
          setOpen(true);
        }}
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-ds-inner border border-ds-border bg-ds-surface px-3 text-[13.5px] text-ds-ink-muted hover:border-ds-border-input sm:justify-start"
      >
        <Search aria-hidden="true" className="size-4 flex-none" />
        <span className="hidden truncate sm:inline">{labels.trigger}</span>
        <span className={`hidden md:inline-flex ${KBD}`} aria-hidden="true">
          Ctrl K
        </span>
      </button>

      <dialog
        ref={dialogRef}
        aria-label={labels.label}
        className="mx-auto mt-[12vh] mb-auto w-[min(calc(100vw-2rem),560px)] max-w-[560px] overflow-hidden rounded-ds-card border border-ds-border bg-ds-surface p-0 text-ds-ink shadow-ds-pop backdrop:bg-ds-ink/50"
        onClose={() => {
          setOpen(false);
          setQuery('');
        }}
        onClick={(e) => {
          if (e.target === dialogRef.current) closePalette(); // a click on the backdrop
        }}
      >
        <div className="flex items-center gap-2.5 border-b border-ds-border px-4 py-3">
          <Search aria-hidden="true" className="size-[18px] flex-none text-ds-ink-subtle" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={filtered.length ? optId(activeIndex) : undefined}
            aria-label={labels.label}
            placeholder={labels.placeholder}
            value={query}
            maxLength={120}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
            className="min-h-11 flex-1 border-none bg-transparent text-[16px] text-ds-ink outline-none placeholder:text-ds-ink-subtle"
          />
        </div>
        <ul id={listId} role="listbox" aria-label={labels.label} className="m-0 max-h-[52vh] list-none overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <li role="presentation" className="px-4 py-7 text-center text-[14px] text-ds-ink-muted">
              {labels.empty(query)}
            </li>
          ) : (
            rendered
          )}
        </ul>
        <div className="flex items-center gap-4 border-t border-ds-border px-4 py-2 text-[12px] text-ds-ink-muted" aria-hidden="true">
          <span className="inline-flex items-center gap-1.5">
            <span className={KBD}>
              <CornerDownLeft className="size-3" />
            </span>
            {labels.hintOpen}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className={KBD}>Esc</span>
            {labels.hintClose}
          </span>
        </div>
        <div aria-live="polite" className="sr-only">
          {liveMsg}
        </div>
      </dialog>
    </>
  );
}
