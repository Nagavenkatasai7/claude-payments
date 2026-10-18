import type { AgentAuth } from './contract';

export * from './contract';

// Stage C1 placeholder: fails closed until the agent sign-in lands (Builder A replaces this
// body with the real implementation). Every token is invalid and the tools are off.
const closed: AgentAuth = {
  async verifyAccessToken() {
    return { ok: false, reason: 'invalid' };
  },
  async toolsActive() {
    return false;
  },
  async recordToolCall() {},
};

export function getAgentAuth(): AgentAuth {
  return closed;
}
