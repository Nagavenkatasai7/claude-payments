/* eslint-disable react/no-children-prop -- Field takes a render-prop child, which createElement cannot type as a child argument */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

describe('Field', () => {
  it('links the label, hint and error to the control', async () => {
    const { Field, Input } = await import('@/components/ds/field');
    const html = renderToStaticMarkup(createElement(Field, {
      name: 'email', label: 'Email', hint: 'We send receipts here', error: 'Enter a valid email',
      children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) =>
        createElement(Input, { id: ids.id, name: 'email', 'aria-describedby': ids.describedBy, invalid: ids.invalid }),
    }));
    const id = /<input[^>]*id="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`<label for="${id}"`);
    expect(html).toContain('aria-invalid="true"');
    const described = /aria-describedby="([^"]+)"/.exec(html)![1].split(' ');
    expect(described.length).toBe(2);
    for (const d of described) expect(html).toContain(`id="${d}"`);
    expect(html).toMatch(/role="alert"[^>]*>Enter a valid email/);
  });
  it('without hint or error there is no describedby and no invalid flag', async () => {
    const { Field, Input } = await import('@/components/ds/field');
    const html = renderToStaticMarkup(createElement(Field, {
      name: 'n', label: 'Name',
      children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) =>
        createElement(Input, { id: ids.id, name: 'n', 'aria-describedby': ids.describedBy, invalid: ids.invalid }),
    }));
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('role="alert"');
  });
  it('a required field marks the label with text, not colour alone', async () => {
    const { Field, Input } = await import('@/components/ds/field');
    const html = renderToStaticMarkup(createElement(Field, {
      name: 'n', label: 'Name', required: true,
      children: (ids: { id: string }) => createElement(Input, { id: ids.id, name: 'n', required: true }),
    }));
    expect(html).toContain('Required');
  });
  it('Checkbox wraps a native checkbox in its label', async () => {
    const { Checkbox } = await import('@/components/ds/field');
    const html = renderToStaticMarkup(createElement(Checkbox, { name: 'r', label: 'Email receipts' }));
    expect(html).toMatch(/<label[^>]*><input type="checkbox"[^>]*name="r"/);
    expect(html).toContain('Email receipts');
  });
  it('Checkbox with an error is invalid and describes itself', async () => {
    const { Checkbox } = await import('@/components/ds/field');
    const html = renderToStaticMarkup(createElement(Checkbox, { name: 'r', label: 'Agree', error: 'Please agree' }));
    expect(html).toContain('aria-invalid="true"');
    const d = /aria-describedby="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${d}"`);
    expect(html).toMatch(/role="alert"[^>]*>Please agree/);
  });
  it('Input uses the landing field look and a visible focus ring', async () => {
    const { Input } = await import('@/components/ds/field');
    const html = renderToStaticMarkup(createElement(Input, { name: 'x' }));
    for (const k of ['min-h-[46px]', 'rounded-ds-inner', 'border-ds-border-input', 'placeholder:text-ds-ink-subtle', 'focus-visible:outline-ds-focus-ring']) expect(html).toContain(k);
  });
  it('Select is a native select with the same look', async () => {
    const { Select } = await import('@/components/ds/field');
    const html = renderToStaticMarkup(createElement(Select, { name: 's', invalid: true }, createElement('option', { value: 'a' }, 'A')));
    expect(html).toMatch(/^<select[^>]*aria-invalid="true"/);
    expect(html).toContain('border-ds-border-input');
  });
});

describe('Checkbox wiring cannot be overridden', () => {
  it('caller props never replace the generated id or aria-describedby', async () => {
    const { Checkbox } = await import('@/components/ds/field');
    const html = renderToStaticMarkup(createElement(Checkbox, { name: 'r', label: 'Agree', hint: 'Why', id: 'evil', 'aria-describedby': 'nowhere' } as never));
    expect(html).not.toContain('id="evil"');
    expect(html).not.toContain('nowhere');
    const d = /aria-describedby="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${d}"`);
  });
});
