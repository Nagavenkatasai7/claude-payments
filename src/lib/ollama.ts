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
    choices: { message: ChatMessage }[];
  };
  return data.choices[0].message;
}
