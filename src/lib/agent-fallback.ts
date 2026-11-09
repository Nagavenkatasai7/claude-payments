// agent-fallback — the one line the WhatsApp bot says when it has nothing else
// to say (Program-Fix 34A). Its own leaf module so the outbox worker can compare
// a turn's reply against it without importing agent.ts (tools, prompt and the
// db graph). agent.ts re-exports it.
// R43: it always says how to reach a person (the HELP keyword works even while
// the model is down: the agent.turn router answers it before the model).
export const FALLBACK_REPLY =
  "Sorry, I'm having trouble right now. Please send that again, or reply HELP to reach a person.";
