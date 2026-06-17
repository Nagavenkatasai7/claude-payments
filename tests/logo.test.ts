import { describe, it, expect } from 'vitest';
import { sanitizeLogoValue, MAX_LOGO_LEN } from '@/lib/logo';

describe('sanitizeLogoValue', () => {
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const svg = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';

  it('accepts an uploaded image data URI (png, svg)', () => {
    expect(sanitizeLogoValue(tinyPng)).toBe(tinyPng);
    expect(sanitizeLogoValue(svg)).toBe(svg);
  });

  it('accepts an https URL (back-compat)', () => {
    expect(sanitizeLogoValue('https://cdn.example.com/logo.png')).toBe('https://cdn.example.com/logo.png');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeLogoValue(`  ${tinyPng}  `)).toBe(tinyPng);
  });

  it('rejects empty / non-string', () => {
    expect(sanitizeLogoValue('')).toBeUndefined();
    expect(sanitizeLogoValue('   ')).toBeUndefined();
    expect(sanitizeLogoValue(undefined)).toBeUndefined();
    expect(sanitizeLogoValue(null)).toBeUndefined();
    expect(sanitizeLogoValue(123)).toBeUndefined();
  });

  it('rejects non-https URLs and javascript: schemes', () => {
    expect(sanitizeLogoValue('http://insecure.example.com/logo.png')).toBeUndefined();
    expect(sanitizeLogoValue('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeLogoValue('ftp://example.com/x.png')).toBeUndefined();
  });

  it('rejects a non-image data URI (e.g. text/html)', () => {
    expect(sanitizeLogoValue('data:text/html;base64,PHNjcmlwdD4=')).toBeUndefined();
  });

  it('rejects an oversized value (> MAX_LOGO_LEN)', () => {
    const huge = `data:image/png;base64,${'A'.repeat(MAX_LOGO_LEN + 1)}`;
    expect(sanitizeLogoValue(huge)).toBeUndefined();
  });
});
