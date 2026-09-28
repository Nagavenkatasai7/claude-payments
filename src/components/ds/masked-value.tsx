'use client';
import * as React from 'react';
import { t } from '@/lib/i18n';
import { INITIAL_MASKED, nextMaskedState, type MaskedEvent, type MaskedState } from '@/lib/ui/masked-state';

export type RevealResult = { value: string } | { error: string };

/**
 * The feature's reveal action. This component never fetches PII itself. The action the caller passes
 * MUST follow the admin reveal pattern: require the session, check the permission BEFORE any read,
 * fetch scoped to the caller's tenant (out of scope returns the same generic error as not found),
 * decrypt inside the action, and record a `pii.reveal` audit event before returning.
 *
 * Any subject id bound into the action (e.g. `reveal={action.bind(null, transferId)}`) arrives from the
 * client and is UNTRUSTED: the action must re-scope it to the caller's tenant, never trust it.
 */
export type RevealAction = () => Promise<RevealResult>;

/** Map an action result to a state event. Only a string value counts; any error text is dropped. */
export function outcomeOf(r: RevealResult): Extract<MaskedEvent, { type: 'revealed' | 'failed' }> {
  if (r && typeof r === 'object' && 'value' in r && typeof r.value === 'string') return { type: 'revealed', value: r.value };
  return { type: 'failed' };
}

const BUTTON =
  'rounded-ds-focus text-[13px] font-semibold text-ds-primary underline-offset-4 hover:underline disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';

/** Presentational view (exported for tests). The value appears only as text content, never in an attribute. */
export function MaskedValueView({
  masked,
  label,
  state,
  onToggle,
}: {
  masked: string;
  label: string;
  state: MaskedState;
  onToggle: () => void;
}) {
  const valueId = `masked-${React.useId()}`;
  const shown = state.phase === 'shown' && state.value !== undefined;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span id={valueId} className="font-mono tabular-nums text-ds-ink">
        {shown ? state.value : masked}
      </span>
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={valueId}
        aria-label={t(shown ? 'ds.masked.hideLabel' : 'ds.masked.showLabel', { label })}
        aria-busy={state.phase === 'loading' || undefined}
        disabled={state.phase === 'loading'}
        onClick={onToggle}
        className={BUTTON}
      >
        {shown ? t('ds.masked.hide') : t('ds.masked.show')}
      </button>
      {state.phase === 'failed' ? (
        <span role="alert" className="text-[13px] text-ds-danger-ink">
          {t('ds.masked.failed')}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A sensitive value, masked by default. Show calls `reveal` once; Hide re-masks without a new call.
 * `masked` must be computed on the SERVER (e.g. '****1234'): never pass the full value into this or any
 * client wrapper, because Client Component props are serialised into the page.
 */
export function MaskedValue({ masked, reveal, label }: { masked: string; reveal: RevealAction; label: string }) {
  const [state, setState] = React.useState<MaskedState>(INITIAL_MASKED);
  const inFlight = React.useRef(false);

  const onToggle = () => {
    if (state.phase === 'shown') {
      setState((s) => nextMaskedState(s, { type: 'hide' }));
      return;
    }
    const next = nextMaskedState(state, { type: 'show-requested' });
    setState(next);
    if (!next.needsCall || inFlight.current) return;
    inFlight.current = true;
    reveal()
      .then(outcomeOf, () => ({ type: 'failed' }) as const)
      .then((ev) => setState((s) => nextMaskedState(s, ev)))
      .finally(() => {
        inFlight.current = false;
      });
  };

  return <MaskedValueView masked={masked} label={label} state={state} onToggle={onToggle} />;
}
