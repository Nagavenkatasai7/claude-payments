import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nextMaskedState, INITIAL_MASKED, type MaskedState } from '@/lib/ui/masked-state';

describe('MaskedValue', () => {
  it('first render is masked and does NOT call reveal', async () => {
    const { MaskedValue } = await import('@/components/ds/masked-value');
    const reveal = vi.fn(async () => ({ value: '123456789012' }));
    const html = renderToStaticMarkup(createElement(MaskedValue, { masked: '****9012', reveal, label: 'Account number' }));
    expect(html).toContain('****9012');
    expect(html).not.toContain('123456789012');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Show/);
    expect(html).toContain('aria-label="Show Account number"');
    const controls = /aria-controls="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${controls}"`);
    expect(reveal).not.toHaveBeenCalled();
  });
  it('the shown value is text content only: never in an attribute (title, data-*, href)', async () => {
    const { MaskedValueView } = await import('@/components/ds/masked-value');
    const state: MaskedState = { phase: 'shown', value: 'SECRET-VALUE-42', needsCall: false };
    const html = renderToStaticMarkup(createElement(MaskedValueView, { masked: '****0042', label: 'Account', state, onToggle: () => {} }));
    expect(html).toContain('>SECRET-VALUE-42<');
    expect(html).not.toMatch(/="[^"]*SECRET-VALUE-42/);
    expect(html).toMatch(/<button[^>]*aria-expanded="true"[^>]*>Hide/);
    expect(html).toContain('aria-label="Hide Account"');
  });
  it('a failure shows the generic message, never the server error text', async () => {
    const { MaskedValueView } = await import('@/components/ds/masked-value');
    const state: MaskedState = { phase: 'failed', needsCall: false };
    const html = renderToStaticMarkup(createElement(MaskedValueView, { masked: '****0042', label: 'Account', state, onToggle: () => {} }));
    expect(html).toContain('This value could not be shown.');
    expect(html).toContain('****0042');
  });
  it('outcomeOf: only a string value counts as revealed; errors and junk are failures', async () => {
    const { outcomeOf } = await import('@/components/ds/masked-value');
    expect(outcomeOf({ value: 'v' })).toEqual({ type: 'revealed', value: 'v' });
    expect(outcomeOf({ error: 'db down for customer 555' })).toEqual({ type: 'failed' });
    expect(outcomeOf({ value: 42 } as never)).toEqual({ type: 'failed' });
    expect(outcomeOf(null as never)).toEqual({ type: 'failed' });
  });
});

describe('nextMaskedState', () => {
  it('state machine: reveal once, hide re-masks, show again reuses the value without re-calling', () => {
    let s = nextMaskedState(INITIAL_MASKED, { type: 'show-requested' });
    expect(s).toMatchObject({ phase: 'loading', needsCall: true });
    s = nextMaskedState(s, { type: 'revealed', value: 'v' });
    expect(s).toMatchObject({ phase: 'shown', value: 'v' });
    s = nextMaskedState(s, { type: 'hide' });
    expect(s).toMatchObject({ phase: 'masked', value: 'v' });
    s = nextMaskedState(s, { type: 'show-requested' });
    expect(s).toMatchObject({ phase: 'shown', needsCall: false });
    expect(nextMaskedState(INITIAL_MASKED, { type: 'failed' }).phase).toBe('failed');
  });
  it('a second show while loading is a no-op (reveal runs exactly once)', () => {
    const loading = nextMaskedState(INITIAL_MASKED, { type: 'show-requested' });
    const again = nextMaskedState(loading, { type: 'show-requested' });
    expect(again).toMatchObject({ phase: 'loading', needsCall: false });
  });
  it('the initial state is masked with no value', () => {
    expect(INITIAL_MASKED).toEqual({ phase: 'masked', needsCall: false });
  });
  it('after a failure, show retries the call', () => {
    const failed = nextMaskedState(nextMaskedState(INITIAL_MASKED, { type: 'show-requested' }), { type: 'failed' });
    expect(failed.value).toBeUndefined();
    expect(nextMaskedState(failed, { type: 'show-requested' })).toMatchObject({ phase: 'loading', needsCall: true });
  });
});
