'use client';
import * as React from 'react';
import { X } from 'lucide-react';
import { t } from '@/lib/i18n';
import { dsCn } from '@/lib/ui/ds-cn';
import { toastReducer, type Toast, type ToastTone } from '@/lib/ui/toast-queue';

type PushToast = (toast: { tone: ToastTone; message: string }) => void;
const ToastContext = React.createContext<PushToast | null>(null);

/** Push a toast from a Client Component inside <Toaster>. */
export function useToast(): PushToast {
  const push = React.useContext(ToastContext);
  if (!push) throw new Error('useToast must be used inside <Toaster>');
  return push;
}

const AUTO_DISMISS_MS = 5000;
const TONE: Record<ToastTone, string> = {
  info: 'border-ds-border bg-ds-surface text-ds-ink',
  success: 'border-ds-success-border bg-ds-success-bg text-ds-success-ink',
  error: 'border-ds-danger-border bg-ds-danger-bg text-ds-danger-ink',
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  React.useEffect(() => {
    if (toast.tone === 'error') return; // errors stay until dismissed
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast.id, toast.tone, onDismiss]);
  return (
    <div className={dsCn('flex items-start gap-3 rounded-ds-inner border px-4 py-3 text-[14px] font-medium shadow-ds-pop', TONE[toast.tone])}>
      <span className="flex-1">{toast.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label={t('ds.toast.dismiss')}
        className="rounded-ds-focus opacity-70 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

/**
 * The toast provider and its live regions. Both regions are always in the DOM, so screen readers
 * announce what is added: info/success politely (role="status"), errors assertively (role="alert").
 */
export function Toaster({ children }: { children?: React.ReactNode }) {
  const [toasts, dispatch] = React.useReducer(toastReducer, []);
  const push = React.useCallback<PushToast>((toast) => dispatch({ type: 'push', toast }), []);
  const dismiss = React.useCallback((id: string) => dispatch({ type: 'dismiss', id }), []);
  const region = 'pointer-events-none fixed right-4 bottom-4 left-4 z-50 flex flex-col items-end gap-2 sm:left-auto [&>div]:pointer-events-auto [&>div]:w-full sm:[&>div]:w-[360px]';
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div role="status" aria-live="polite" className={region}>
        {toasts.filter((x) => x.tone !== 'error').map((x) => <ToastItem key={x.id} toast={x} onDismiss={dismiss} />)}
      </div>
      <div role="alert" className={dsCn(region, 'bottom-auto top-4')}>
        {toasts.filter((x) => x.tone === 'error').map((x) => <ToastItem key={x.id} toast={x} onDismiss={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}
