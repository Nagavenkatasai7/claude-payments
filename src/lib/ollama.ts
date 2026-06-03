import { env } from './env';
import type { ChatMessage, ChatTool } from './types';

export async function chat(
  messages: ChatMessage[],
  tools: ChatTool[],
): Promise<ChatMessage> {
  const res = await fetch(`${env.ollamaBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ollamaApiKey}`,
    },
    body: JSON.stringify({
      model: env.ollamaModel,
      messages,
      tools,
      tool_choice: 'auto',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: ChatMessage }[];
  };
  // Guard the happy-path indexing: a missing/empty `choices` (a momentarily
  // malformed upstream response) must throw a CLEAR, catchable error rather than
  // a bare "cannot read properties of undefined" TypeError — the agent retries
  // chat() once and otherwise degrades to a friendly fallback.
  const message = data?.choices?.[0]?.message;
  if (!message) {
    throw new Error('Ollama response missing choices[0].message');
  }
  return message;
}
