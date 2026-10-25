// llm-models — which Claude model, effort and output cap each AI task uses
// (owner decision 2026-10-25, report https://claude.ai/artifact/WXF1kgUm75MwQqJhuyTkvb).
// Pure; no I/O. Model ids: node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts (type Model).
//
// The customer bot runs on Claude Haiku 5.5 at low effort. ANTHROPIC_AGENT_MODEL
// (optional) moves the bot to another listed model with no code change, e.g.
// claude-sonnet-5-5 if Haiku fails a case of the nightly eval. Staff helpers
// whose output feeds a compliance decision run on Claude Sonnet 5.5.

export type LlmTask =
  | 'agent'
  | 'aml_explain'
  | 'kyc_review'
  | 'review_triage'
  | 'ops_diagnosis'
  | 'ticket_draft'
  | 'ticket_summary'
  | 'ticket_triage'
  | 'customer_summary'
  | 'corridor_brief'
  | 'partner_health';

export type LlmEffort = 'low' | 'medium' | 'high';

export interface LlmTaskConfig {
  model: string;
  effort: LlmEffort;
  /** Thinking counts toward this cap, so it leaves room above the visible reply. */
  maxTokens: number;
  /** One more call on this model when the first one answers 529 overloaded. */
  overloadFallbackModel?: string;
}

export const HAIKU = 'claude-haiku-5-5';
export const SONNET = 'claude-sonnet-5-5';

/** Models ANTHROPIC_AGENT_MODEL may name. Anything else is ignored. */
export const AGENT_MODEL_CHOICES: readonly string[] = [HAIKU, SONNET];

const SHORT = 4096;
const LONG = 8192;

const TASKS: Readonly<Record<LlmTask, LlmTaskConfig>> = {
  agent: { model: HAIKU, effort: 'low', maxTokens: LONG, overloadFallbackModel: SONNET },
  aml_explain: { model: SONNET, effort: 'medium', maxTokens: LONG },
  kyc_review: { model: SONNET, effort: 'low', maxTokens: LONG },
  review_triage: { model: SONNET, effort: 'low', maxTokens: LONG },
  ops_diagnosis: { model: SONNET, effort: 'low', maxTokens: LONG },
  ticket_draft: { model: HAIKU, effort: 'low', maxTokens: SHORT },
  ticket_summary: { model: HAIKU, effort: 'low', maxTokens: SHORT },
  ticket_triage: { model: HAIKU, effort: 'low', maxTokens: SHORT },
  customer_summary: { model: HAIKU, effort: 'low', maxTokens: SHORT },
  corridor_brief: { model: HAIKU, effort: 'low', maxTokens: SHORT },
  partner_health: { model: HAIKU, effort: 'low', maxTokens: SHORT },
};

/** The config for `task`. `agentModel` (ANTHROPIC_AGENT_MODEL) applies to the bot only. */
export function llmTaskConfig(task: LlmTask, opts: { agentModel?: string } = {}): LlmTaskConfig {
  const base = TASKS[task];
  if (task !== 'agent') return base;
  const override = (opts.agentModel ?? '').trim();
  if (!override || !AGENT_MODEL_CHOICES.includes(override) || override === base.model) return base;
  // The bot already runs on the fallback model: no second model to try.
  const overloadFallbackModel = override === SONNET ? undefined : base.overloadFallbackModel;
  return { ...base, model: override, overloadFallbackModel };
}
