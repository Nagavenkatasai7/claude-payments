import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT } from '@/lib/prompt';

describe('SYSTEM_PROMPT', () => {
  it('names the tools the agent must use', () => {
    expect(SYSTEM_PROMPT).toContain('get_quote');
    expect(SYSTEM_PROMPT).toContain('create_transfer');
    expect(SYSTEM_PROMPT).toContain('generate_payment_link');
  });

  it('forbids asking for card details in chat', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('card');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('never');
  });

  it('includes the conditional ENHANCED VERIFICATION block gated on edd_required', () => {
    expect(SYSTEM_PROMPT).toContain('ENHANCED VERIFICATION');
    expect(SYSTEM_PROMPT).toContain('edd_required');
    expect(SYSTEM_PROMPT).toContain('source_of_funds');
    expect(SYSTEM_PROMPT).toContain('occupation');
  });

  it('instructs the bot to ask NOTHING extra when edd_required is false (dormancy)', () => {
    expect(SYSTEM_PROMPT).toMatch(/edd_required is false/i);
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('never ask');
  });
});
