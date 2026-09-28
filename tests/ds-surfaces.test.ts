import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

describe('Card / Badge / StatusPill / Money / Skeleton', () => {
  it('Card is the landing card', async () => {
    const { Card } = await import('@/components/ds/card');
    const html = renderToStaticMarkup(createElement(Card, null, 'x'));
    for (const k of ['rounded-ds-card', 'border-ds-border', 'bg-ds-surface']) expect(html).toMatch(new RegExp(`^<div class="[^"]*${k}`));
  });
  it('Card renders as another element when asked', async () => {
    const { Card } = await import('@/components/ds/card');
    expect(renderToStaticMarkup(createElement(Card, { as: 'section' }, 'x'))).toMatch(/^<section class="[^"]*rounded-ds-card/);
  });
  it('Badge tones: warning is the landing Review tag, danger/success the ds sets', async () => {
    const { Badge } = await import('@/components/ds/badge');
    const warn = renderToStaticMarkup(createElement(Badge, { tone: 'warning' }, 'w'));
    for (const k of ['bg-ds-warning-bg', 'text-ds-warning-ink', 'border-ds-warning-border', 'rounded-full']) expect(warn).toContain(k);
    const danger = renderToStaticMarkup(createElement(Badge, { tone: 'danger' }, 'd'));
    for (const k of ['bg-ds-danger-bg', 'text-ds-danger-ink', 'border-ds-danger-border']) expect(danger).toContain(k);
    const ok = renderToStaticMarkup(createElement(Badge, { tone: 'success' }, 's'));
    for (const k of ['bg-ds-success-bg', 'text-ds-success-ink', 'border-ds-success-border']) expect(ok).toContain(k);
  });
  it('StatusPill shows text plus an icon, never colour alone', async () => {
    const { StatusPill } = await import('@/components/ds/status-pill');
    const html = renderToStaticMarkup(createElement(StatusPill, { status: 'blocked' }));
    expect(html).toContain('On hold');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).not.toContain('>blocked<');
  });
  it('StatusPill in_review uses the warning (Review tag) colours', async () => {
    const { StatusPill } = await import('@/components/ds/status-pill');
    const html = renderToStaticMarkup(createElement(StatusPill, { status: 'in_review' }));
    expect(html).toContain('bg-ds-warning-bg');
    expect(html).toContain('Under review');
  });
  it('StatusPill applies the refund overlay', async () => {
    const { StatusPill } = await import('@/components/ds/status-pill');
    expect(renderToStaticMarkup(createElement(StatusPill, { status: 'paid', refundStatus: 'completed' }))).toContain('Refunded');
  });
  it('Money renders tabular numbers', async () => {
    const { Money } = await import('@/components/ds/money');
    expect(renderToStaticMarkup(createElement(Money, { amount: 10, currency: 'USD' }))).toBe('<span class="tabular-nums">$10.00</span>');
  });
  it('Skeleton is a decorative pulse that respects reduced motion', async () => {
    const { Skeleton } = await import('@/components/ds/skeleton');
    const html = renderToStaticMarkup(createElement(Skeleton, { className: 'h-6 w-24' }));
    for (const k of ['animate-pulse', 'motion-reduce:animate-none', 'bg-ds-tint', 'h-6', 'w-24', 'aria-hidden="true"']) expect(html).toContain(k);
  });
});
