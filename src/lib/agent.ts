import { SYSTEM_PROMPT } from './prompt';
import { toolSchemas, executeTool } from './tools';
import type { ChatMessage, ChatTool } from './types';
import type { Store } from './store';

const MAX_TOOL_ROUNDS = 6;
const FALLBACK_REPLY =
  "Sorry, I'm having trouble right now. Could you send that again?";

export interface AgentDeps {
  chat: (messages: ChatMessage[], tools: ChatTool[]) => Promise<ChatMessage>;
  store: Store;
}

export function createAgent(deps: AgentDeps) {
  async function runAgentTurn(
    phone: string,
    incomingText: string,
  ): Promise<string> {
    const history = await deps.store.getConversation(phone);
    history.push({ role: 'user', content: incomingText });

    let reply = '';

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const messages: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
      ];
      const assistant = await deps.chat(messages, toolSchemas);
      history.push(assistant);

      if (assistant.tool_calls && assistant.tool_calls.length > 0) {
        for (const call of assistant.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || '{}');
          } catch {
            args = {};
          }
          const result = await executeTool(call.function.name, args, {
            phone,
            store: deps.store,
          });
          history.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
        continue;
      }

      reply = assistant.content || '';
      break;
    }

    if (!reply) reply = FALLBACK_REPLY;
    await deps.store.saveConversation(phone, history);
    return reply;
  }

  return { runAgentTurn };
}
