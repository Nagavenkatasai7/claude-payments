// The reveal state machine behind MaskedValue. Pure, so it is tested without a DOM.
// `needsCall` tells the component to call the feature's reveal action; it is true only on the first
// show (or a retry after a failure). A revealed value is cached for the component's lifetime.
export type MaskedPhase = 'masked' | 'loading' | 'shown' | 'failed';
export type MaskedState = { phase: MaskedPhase; value?: string; needsCall: boolean };
export type MaskedEvent =
  | { type: 'show-requested' }
  | { type: 'revealed'; value: string }
  | { type: 'failed' }
  | { type: 'hide' };

export const INITIAL_MASKED: MaskedState = { phase: 'masked', needsCall: false };

export function nextMaskedState(s: MaskedState, ev: MaskedEvent): MaskedState {
  switch (ev.type) {
    case 'show-requested':
      if (s.phase === 'loading') return { ...s, needsCall: false };
      if (s.value !== undefined) return { phase: 'shown', value: s.value, needsCall: false };
      return { phase: 'loading', needsCall: true };
    case 'revealed':
      return { phase: 'shown', value: ev.value, needsCall: false };
    case 'failed':
      return { phase: 'failed', needsCall: false };
    case 'hide':
      return { ...s, phase: 'masked', needsCall: false };
  }
}
