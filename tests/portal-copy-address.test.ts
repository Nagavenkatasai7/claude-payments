import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopyAddress } from '@/app/portal/ai-apps/copy-address';

// TGFL custom host, design §5.4 / §6 item 28: the client "Copy" button of the connector box. Its
// text comes from props (the server page translates), so the client bundle carries no catalogue.

describe('CopyAddress', () => {
  it('renders the label and the aria-label it is given', () => {
    const html = renderToStaticMarkup(createElement(CopyAddress, { text: 'https://x.example/api/mcp', label: 'Kopieren', copiedLabel: 'Kopiert', ariaLabel: 'Adresse kopieren' }));
    expect(html).toContain('>Kopieren<');
    expect(html).toContain('aria-label="Adresse kopieren"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('Kopiert');
  });

  it('has no hard-coded English and no i18n import', () => {
    const src = readFileSync('src/app/portal/ai-apps/copy-address.tsx', 'utf8');
    expect(src).toMatch(/^'use client';/);
    expect(src).not.toMatch(/@\/lib\/i18n/);
    expect(src).not.toMatch(/>\s*(Copy|Copied)\s*</);
    expect(src).not.toMatch(/['"](Copy|Copied)['"]/);
  });
});
