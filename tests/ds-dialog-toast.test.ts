import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

describe('ConfirmDialog / Toaster', () => {
  it('ConfirmDialog form: the reason field carries required + minLength, a label and a hint; confirm starts disabled', async () => {
    const { ConfirmDialogForm } = await import('@/components/ds/confirm-dialog');
    const html = renderToStaticMarkup(createElement(ConfirmDialogForm, { confirmLabel: 'Release', reasonMin: 10, action: async () => {} }));
    expect(html).toMatch(/<textarea[^>]*name="reason"[^>]*required=""[^>]*minLength="10"/);
    expect(html).toMatch(/<label[^>]*for="[^"]+"[^>]*>Reason/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Release/);
    expect(html).toContain('At least 10 characters. This is recorded.');
    const d = /<textarea[^>]*aria-describedby="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${d}"`);
  });
  it('ConfirmDialog form: a destructive confirm uses the danger button', async () => {
    const { ConfirmDialogForm } = await import('@/components/ds/confirm-dialog');
    const html = renderToStaticMarkup(createElement(ConfirmDialogForm, { confirmLabel: 'Block', destructive: true, action: async () => {} }));
    expect(html).toMatch(/<button[^>]*bg-ds-danger-bg[^>]*type="submit"/);
    expect(html).toMatch(/minLength="10"/); // default minimum
  });
  it('ConfirmDialog renders only its trigger when closed (nothing else in the page)', async () => {
    const { ConfirmDialog } = await import('@/components/ds/confirm-dialog');
    const html = renderToStaticMarkup(createElement(ConfirmDialog, {
      trigger: createElement('button', { type: 'button' }, 'Release funds'),
      title: 'Release this transfer?', body: 'It will be sent.', confirmLabel: 'Release', action: async () => {},
    }));
    expect(html).toContain('Release funds');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('<textarea');
  });
  it('Toaster renders a polite status region and an alert region, empty at first', async () => {
    const { Toaster } = await import('@/components/ds/toast');
    const html = renderToStaticMarkup(createElement(Toaster, null, createElement('p', null, 'page')));
    expect(html).toContain('<p>page</p>');
    expect(html).toMatch(/role="status"[^>]*aria-live="polite"/);
    expect(html).toMatch(/role="alert"/);
  });
  it('useToast outside a Toaster fails loudly', async () => {
    const { useToast } = await import('@/components/ds/toast');
    function Probe() { useToast(); return null; }
    expect(() => renderToStaticMarkup(createElement(Probe))).toThrow(/Toaster/);
  });
});
