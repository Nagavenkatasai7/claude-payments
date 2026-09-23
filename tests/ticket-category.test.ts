import { describe, it, expect } from 'vitest';
import { HUMAN_HELP_CATEGORY, ticketCategoryLabel } from '@/lib/ticket-category';
import { TICKET_CATEGORIES } from '@/lib/ticket-ai';

// Program-Fix 34B: the staff queue renders a category outside the copilot's
// closed triage list without breaking.
describe('ticketCategoryLabel', () => {
  it('labels a human-help case "Human help"', () => {
    expect(ticketCategoryLabel(HUMAN_HELP_CATEGORY)).toBe('Human help');
  });
  it('renders the copilot categories as-is, and an unknown value as-is', () => {
    for (const c of TICKET_CATEGORIES) expect(ticketCategoryLabel(c)).toBe(c);
    expect(ticketCategoryLabel('something_new')).toBe('something_new');
  });
  it('renders no category as a dash', () => {
    expect(ticketCategoryLabel(undefined)).toBe('—');
    expect(ticketCategoryLabel(null)).toBe('—');
    expect(ticketCategoryLabel('')).toBe('—');
  });
  it('does not widen the copilot triage list', () => {
    expect((TICKET_CATEGORIES as readonly string[]).includes(HUMAN_HELP_CATEGORY)).toBe(false);
  });
});
