// The ONE result shape every /partner server action returns (UI redesign M3, shared action rules).
// `error` is fixed, translated copy: never an exception message, never request input echoed back.
export type ActionResult = { ok: true } | { ok: false; error: string };
