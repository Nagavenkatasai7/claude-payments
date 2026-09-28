// Toast queue state. Pure: the Toaster component holds it in useReducer.
export type ToastTone = 'info' | 'success' | 'error';
export type Toast = { id: string; tone: ToastTone; message: string };
export type ToastEvent = { type: 'push'; toast: Omit<Toast, 'id'> } | { type: 'dismiss'; id: string };

export const MAX_TOASTS = 3;
let seq = 0;

/** At most MAX_TOASTS visible, newest last; the oldest drops off. */
export function toastReducer(state: Toast[], ev: ToastEvent): Toast[] {
  if (ev.type === 'push') {
    seq += 1;
    return [...state, { ...ev.toast, id: `toast-${seq}` }].slice(-MAX_TOASTS);
  }
  return state.some((t) => t.id === ev.id) ? state.filter((t) => t.id !== ev.id) : state;
}
