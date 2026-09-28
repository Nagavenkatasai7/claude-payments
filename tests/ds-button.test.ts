import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buttonVariants, Button } from '@/components/ds/button';

describe('ds Button = the landing pill recipes', () => {
  it('whatsapp: WhatsApp-green pill, dark label, CTA shadow, lift on hover', () => {
    const c = buttonVariants({ variant: 'whatsapp', size: 'lg' });
    for (const k of ['rounded-full', 'bg-ds-cta-whatsapp', 'text-ds-on-whatsapp', 'shadow-ds-cta', 'hover:bg-ds-cta-whatsapp-hover', 'min-h-[52px]', 'font-bold'])
      expect(c).toContain(k);
  });
  it('primary: follows the partner-overridable --ds-primary', () => {
    const c = buttonVariants({ variant: 'primary' });
    for (const k of ['rounded-full', 'bg-ds-primary', 'text-ds-on-primary', 'shadow-ds-primary', 'hover:bg-ds-primary-hover']) expect(c).toContain(k);
  });
  it('ghost: white/outline pill', () => {
    const c = buttonVariants({ variant: 'ghost' });
    for (const k of ['rounded-full', 'border-ds-border-strong', 'text-ds-ink']) expect(c).toContain(k);
  });
  it('danger: the ds danger set', () => {
    const c = buttonVariants({ variant: 'danger' });
    for (const k of ['rounded-full', 'bg-ds-danger-bg', 'text-ds-danger-ink', 'border-ds-danger-border']) expect(c).toContain(k);
  });
  it('every variant has a visible focus ring', () => {
    for (const v of ['whatsapp', 'primary', 'ghost', 'danger', 'link'] as const)
      expect(buttonVariants({ variant: v })).toContain('focus-visible:outline-ds-focus-ring');
  });
  it('the link variant is not padded like a pill', () => {
    const c = buttonVariants({ variant: 'link' });
    expect(c).not.toContain('min-h-[52px]');
    expect(c).not.toContain('px-7');
  });
  it('the hover lift is switched off for reduced motion', () => {
    expect(buttonVariants({ variant: 'primary' })).toContain('motion-reduce:hover:translate-y-0');
  });
  it('renders type="button" by default (never an accidental submit)', () => {
    expect(renderToStaticMarkup(createElement(Button, {}, 'Go'))).toContain('type="button"');
  });
  it('an explicit type="submit" is kept', () => {
    expect(renderToStaticMarkup(createElement(Button, { type: 'submit' }, 'Go'))).toContain('type="submit"');
  });
  it('dsCn keeps both the size and the colour text utilities', () => {
    const html = renderToStaticMarkup(createElement(Button, { variant: 'whatsapp', size: 'lg' }, 'Go'));
    expect(html).toContain('text-[16px]');
    expect(html).toContain('text-ds-on-whatsapp');
  });
  it('asChild renders the child element with the pill classes and no type attribute', () => {
    const html = renderToStaticMarkup(createElement(Button, { asChild: true, variant: 'ghost' }, createElement('a', { href: '/x' }, 'Go')));
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="/x"');
    expect(html).toContain('rounded-full');
    expect(html).not.toContain('type=');
  });
});
