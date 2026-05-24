import { describe, it, expect } from 'vitest';
import {
  truncateLabel,
  disambiguateNames,
  recipientButtonId,
  someoneNewButtonId,
  approveButtonId,
  cancelButtonId,
  parseButtonId,
  BUTTON_LABEL_MAX,
} from '@/lib/whatsapp-buttons';

describe('truncateLabel', () => {
  it('returns short labels untouched', () => {
    expect(truncateLabel('Mom')).toBe('Mom');
  });

  it('truncates at 17 chars and appends a single ellipsis to reach 18 chars total', () => {
    const long = 'ThisNameIsWayTooLongForAButton';
    const out = truncateLabel(long);
    expect(out).toBe('ThisNameIsWayTooL…');
    expect(out.length).toBeLessThanOrEqual(BUTTON_LABEL_MAX);
  });

  it('uses a single … character, not three dots', () => {
    expect(truncateLabel('A'.repeat(30))).not.toContain('...');
    expect(truncateLabel('A'.repeat(30))).toContain('…');
  });

  it('returns input when length === BUTTON_LABEL_MAX', () => {
    const exact = 'A'.repeat(BUTTON_LABEL_MAX);
    expect(truncateLabel(exact)).toBe(exact);
  });
});

describe('disambiguateNames', () => {
  it('returns names untouched when no collisions', () => {
    const labels = disambiguateNames([
      { name: 'Mom', recipientPhone: '919876543210' },
      { name: 'Brother', recipientPhone: '919999999999' },
    ]);
    expect(labels).toEqual(['Mom', 'Brother']);
  });

  it('appends a (…NNNN) suffix when names collide', () => {
    const labels = disambiguateNames([
      { name: 'Mom', recipientPhone: '919876543210' },
      { name: 'Mom', recipientPhone: '919999997890' },
    ]);
    expect(labels).toEqual(['Mom (…3210)', 'Mom (…7890)']);
  });

  it('disambiguates only the colliding names, leaves unique names clean', () => {
    const labels = disambiguateNames([
      { name: 'Mom', recipientPhone: '919876543210' },
      { name: 'Mom', recipientPhone: '919999997890' },
      { name: 'Brother', recipientPhone: '919555551234' },
    ]);
    expect(labels).toEqual(['Mom (…3210)', 'Mom (…7890)', 'Brother']);
  });
});

describe('button id factories', () => {
  it('recipientButtonId returns "recipient:<phone>"', () => {
    expect(recipientButtonId('919876543210')).toBe('recipient:919876543210');
  });

  it('someoneNewButtonId returns "recipient:new"', () => {
    expect(someoneNewButtonId()).toBe('recipient:new');
  });

  it('approveButtonId returns "approve:<draftId>"', () => {
    expect(approveButtonId('abc12345')).toBe('approve:abc12345');
  });

  it('cancelButtonId returns "cancel:<draftId>"', () => {
    expect(cancelButtonId('abc12345')).toBe('cancel:abc12345');
  });
});

describe('parseButtonId', () => {
  it('parses recipient phone tap', () => {
    expect(parseButtonId('recipient:919876543210')).toEqual({
      kind: 'recipient',
      recipientPhone: '919876543210',
    });
  });

  it('parses someone-new tap', () => {
    expect(parseButtonId('recipient:new')).toEqual({ kind: 'recipient_new' });
  });

  it('parses approve tap', () => {
    expect(parseButtonId('approve:abc12345')).toEqual({
      kind: 'approve',
      draftId: 'abc12345',
    });
  });

  it('parses cancel tap', () => {
    expect(parseButtonId('cancel:abc12345')).toEqual({
      kind: 'cancel',
      draftId: 'abc12345',
    });
  });

  it('returns null for empty input', () => {
    expect(parseButtonId('')).toBeNull();
  });

  it('returns null for missing prefix', () => {
    expect(parseButtonId('919876543210')).toBeNull();
  });

  it('returns null for unknown prefix', () => {
    expect(parseButtonId('foo:bar')).toBeNull();
  });

  it('returns null for embedded newline', () => {
    expect(parseButtonId('approve:abc\n12345')).toBeNull();
  });

  it('returns null for recipient phone with non-digits', () => {
    expect(parseButtonId('recipient:91-987-654-3210')).toBeNull();
  });

  it('returns null for missing colon', () => {
    expect(parseButtonId('approveabc12345')).toBeNull();
  });
});
