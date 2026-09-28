import { describe, it, expect } from 'vitest';
import { toastReducer, MAX_TOASTS } from '@/lib/ui/toast-queue';
describe('toastReducer', () => {
  it('keeps at most 3, newest last, with unique ids', () => {
    expect(MAX_TOASTS).toBe(3);
    let s = toastReducer([], { type: 'push', toast: { tone: 'info', message: '1' } });
    for (const m of ['2', '3', '4']) s = toastReducer(s, { type: 'push', toast: { tone: 'info', message: m } });
    expect(s.map((t) => t.message)).toEqual(['2', '3', '4']);
    expect(new Set(s.map((t) => t.id)).size).toBe(3);
  });
  it('dismiss removes only that id', () => {
    const s = toastReducer(toastReducer([], { type: 'push', toast: { tone: 'info', message: 'a' } }), { type: 'push', toast: { tone: 'error', message: 'b' } });
    expect(toastReducer(s, { type: 'dismiss', id: s[0].id }).map((t) => t.message)).toEqual(['b']);
  });
  it('dismissing an unknown id returns the same state', () => {
    const s = toastReducer([], { type: 'push', toast: { tone: 'success', message: 'a' } });
    expect(toastReducer(s, { type: 'dismiss', id: 'nope' })).toBe(s);
  });
});
