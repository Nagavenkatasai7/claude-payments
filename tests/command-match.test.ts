import { describe, it, expect } from 'vitest';
import { matchesCommand } from '@/lib/command-match';

// command-match: the ONE search rule behind both command palettes (the legacy /admin-dashboard
// palette and the /partner palette). Every whitespace-separated term must appear, case-insensitive,
// in the label, the group or the extra keywords.
const item = { label: 'Refunds', group: 'Go to', keywords: 'money back reversal' };

describe('matchesCommand', () => {
  it('an empty or blank query matches everything', () => {
    expect(matchesCommand(item, '')).toBe(true);
    expect(matchesCommand(item, '   ')).toBe(true);
  });
  it('matches on the label, the group or a keyword, ignoring case', () => {
    expect(matchesCommand(item, 'REF')).toBe(true);
    expect(matchesCommand(item, 'go')).toBe(true);
    expect(matchesCommand(item, 'reversal')).toBe(true);
  });
  it('every term must appear (AND)', () => {
    expect(matchesCommand(item, 'refunds money')).toBe(true);
    expect(matchesCommand(item, 'refunds staff')).toBe(false);
  });
  it('an item without keywords still matches on its label', () => {
    expect(matchesCommand({ label: 'Staff', group: 'Go to' }, 'sta')).toBe(true);
    expect(matchesCommand({ label: 'Staff', group: 'Go to' }, 'undefined')).toBe(false);
  });
});
