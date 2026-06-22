import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Customer } from '@/lib/types';
import { Card, CardContent } from '@/components/ui/card';
import { logoutAction } from './actions';
import { maskPhone } from './format';

// AccountShell — the shared light "web dashboard" chrome for the AUTHENTICATED
// customer portal: a sticky top nav (brand · Overview/Transfers/Support/Settings ·
// account menu with Log out) over a centered max-w-5xl content area. Reuses the
// app's default light theme + @/components/ui (no WhatsApp-dark hex). Public auth
// pages (login/register/reset) do NOT use this — they have no logged-in nav.
//
// Kept deliberately simple: it's a CUSTOMER surface, so few links, clear labels,
// big targets. Server component (renders a server-action logout form inline).

export type AccountNav = 'overview' | 'transfers' | 'support' | 'settings';

const NAV: { key: AccountNav; label: string; href: string }[] = [
  { key: 'overview', label: 'Overview', href: '/account' },
  { key: 'transfers', label: 'Transfers', href: '/account/history' },
  { key: 'support', label: 'Support', href: '/account/support' },
  { key: 'settings', label: 'Settings', href: '/account/settings' },
];

function navClass(isActive: boolean): string {
  return isActive
    ? 'bg-primary/10 text-primary'
    : 'text-muted-foreground hover:bg-muted hover:text-foreground';
}

export function AccountShell({
  active,
  customer,
  children,
}: {
  active: AccountNav;
  customer: Customer;
  children: ReactNode;
}) {
  return (
    <div className="min-h-svh bg-muted/30">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
          <Link href="/account" className="text-lg font-bold tracking-tight text-foreground">
            Smart<span className="text-primary">Remit</span>
          </Link>
          <nav className="ml-2 hidden items-center gap-1 sm:flex">
            {NAV.map((n) => (
              <Link
                key={n.key}
                href={n.href}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${navClass(active === n.key)}`}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
              {maskPhone(customer.senderPhone)}
            </span>
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Log out
              </button>
            </form>
          </div>
        </div>
        {/* Mobile nav: a horizontally-scrollable row under the brand. */}
        <nav className="flex items-center gap-1 overflow-x-auto border-t border-border px-3 py-2 sm:hidden">
          {NAV.map((n) => (
            <Link
              key={n.key}
              href={n.href}
              className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium ${navClass(active === n.key)}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}

/** The page title block (matches the admin sh-page-head rhythm, lighter weight). */
export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
        {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A compact metric card for the Overview stat row. */
export function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <Card>
      <CardContent>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="mt-1.5 text-2xl font-bold tabular-nums text-foreground">{value}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}
