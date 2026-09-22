# Ledger plan document schema (collection `plans`, one JSON file per doc)

Working copies live in `~/dev/program-ledger/plans/<id>.json` (outside the repo); the ledger database is the source of truth. Each doc is valid JSON and under 200 KB. It contains no phone numbers, personal names, emails, secrets, tokens or credential values.

```jsonc
{
  "id": "p1-w2",                     // doc id: p0, p1-w1..p1-w4, p2, p3, p4
  "order": 12,                       // sort key: phase*10 + wave (phase outline = phase*10)
  "phase": 1, "wave": 2,             // wave = null for a phase-level doc
  "kind": "wave",                    // "wave" | "phase-outline" | "phase-summary"
  "title": "Wave 2 · Money-safe core, part 2",
  "status": "awaiting_approval",     // done | awaiting_approval | approved | building | outline | not_started
  "planVersion": 1,
  "updatedAt": "2026-09-21T21:30:00Z",
  "source": {"doc": "docs/superpowers/plans/2026-09-21-phase1-wave2-money-safe-core.md", "pr": 259, "baseSha": "bf4b083"},  // nulls allowed
  "approval": {"state": "pending", "at": null, "by": null, "ref": null},   // pending | approved | not_needed
  "headline": "One plain sentence, 25 words max.",
  "story": "Explain it like the reader is brand new: 3-6 short sentences, one everyday analogy, no jargon.",
  "whyNow": "1-3 plain sentences: why this comes now.",
  "flow": { "caption": "The order we do it in", "steps": [ {"label": "4 words max", "note": "10 words max", "tone": "done|next|todo|gate|bad|new"} ] },
  "items": [
    {
      "key": "task-9", "fix": 13, "planTask": 9,       // planTask null when there is no plan task yet
      "title": "Plain title, 10 words max",
      "status": "done|merged|in_review|building|planned|awaiting_approval|outline",
      "story": "3-5 short sentences a newcomer understands. One analogy. No code words.",
      "before": {"caption": "Today", "steps": [ {"label": "4 words max", "note": "10 words max", "tone": "ok|bad|neutral"} ]},
      "after":  {"caption": "After the fix", "steps": [ {"label": "...", "note": "...", "tone": "ok|new|neutral"} ]},
      "changes": ["What changes, in plain words"],
      "proof": ["How we will know it works, in plain words (tests, live check)"],
      "youDo": ["Steps only the owner can do; [] if none"],
      "leftover": ["Known residual risk left for later; [] if none"],
      "tech": {"branch": "fix/…", "component": "corridors-fx", "migration": "none", "findings": ["obs-08"], "files": ["src/lib/rate.ts"], "tests": "+3 files, +72 tests", "steps": ["Short technical step summary"], "evidence": "done items only: what proved it (PR, merge SHA, smoke, live check)"}
    }
  ],
  "reviews": [ {"at": "2026-09-21T20:30:00Z", "name": "Money/security review", "by": "Opus 5", "found": 2, "fixed": 2, "summary": "Plain words"} ],
  "ownerSteps": ["Plan-level owner steps"],
  "glossary": [ {"term": "outbox", "plain": "A to-do list the server writes before it acts, so nothing gets lost if it crashes."} ]   // 8 terms max
}
```

Diagram rules. The page draws `before`, `after` and `flow` as boxes joined by arrows.
- Use 3–6 steps each.
- In `before`, mark the broken step `bad`.
- In `after`, mark the new safety check `new`. `after` usually repeats `before` with the bad step replaced or a new gate inserted.
- Labels are short verbs or nouns ("Customer pays", "Check rate age").

Voice. `story` and `headline` are written for someone with no technical background: short sentences, one concrete analogy (post office, bank teller, locked drawer, receipt), no acronyms. Technical detail goes only in `tech`. Be accurate: every claim must be true to the source plan, the PRs or the code. Never invent status.
