import { describe, it, expect } from 'vitest';
import {
  HUMAN_HELP_CATEGORY,
  MFA_RECOVERY_CATEGORY,
  TEAM_QUESTION_CATEGORY,
  keepsCategoryOnTriage,
  ticketCategoryLabel,
} from '@/lib/ticket-category';
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
    for (const c of [HUMAN_HELP_CATEGORY, MFA_RECOVERY_CATEGORY, TEAM_QUESTION_CATEGORY]) {
      expect((TICKET_CATEGORIES as readonly string[]).includes(c), c).toBe(false);
    }
  });
  it('labels a two-step recovery request and a team question (never the raw value)', () => {
    expect(MFA_RECOVERY_CATEGORY).toBe('mfa_recovery');
    expect(TEAM_QUESTION_CATEGORY).toBe('team_question');
    expect(ticketCategoryLabel(MFA_RECOVERY_CATEGORY)).toBe('Two-step recovery');
    expect(ticketCategoryLabel(TEAM_QUESTION_CATEGORY)).toBe('Team question');
  });
  it('triage keeps a code-set category (help case, recovery request); it may replace any other', () => {
    expect(keepsCategoryOnTriage(HUMAN_HELP_CATEGORY)).toBe(true);
    expect(keepsCategoryOnTriage(MFA_RECOVERY_CATEGORY)).toBe(true);
    for (const c of [...TICKET_CATEGORIES, TEAM_QUESTION_CATEGORY, 'something_new', '', null, undefined]) {
      expect(keepsCategoryOnTriage(c), String(c)).toBe(false);
    }
  });
});
