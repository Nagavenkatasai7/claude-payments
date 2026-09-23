// agent-fallback — the one line the WhatsApp bot says when it has nothing else
// to say (Program-Fix 34A). Its own leaf module so the outbox worker can compare
// a turn's reply against it without importing agent.ts (tools, prompt and the
// db graph). agent.ts re-exports it.
export const FALLBACK_REPLY =
  "Sorry, I'm having trouble right now. Could you send that again?";
