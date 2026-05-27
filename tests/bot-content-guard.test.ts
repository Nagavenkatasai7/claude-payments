import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Hard rule (P2): no string assigned to a chat-message `content` field
// anywhere in the bot code path may contain the word "partner".
// This guards against accidentally surfacing tenant-internal terminology
// to end-customers via the WhatsApp bot.
describe('P2 hard rule: bot never mentions partner in any chat content', () => {
  const filesToScan = [
    'src/lib/prompt.ts',
    'src/lib/agent.ts',
    'src/lib/tools.ts',
    'tests/agent.test.ts',
    'tests/e2e.test.ts',
  ];

  for (const rel of filesToScan) {
    it(`${rel} has no chat content containing "partner"`, () => {
      const full = resolve(process.cwd(), rel);
      const contents = readFileSync(full, 'utf-8');
      // Find every `content: '...'` literal in the file. We iterate via
      // matchAll which yields every regex match at once.
      const pattern = /content:\s*['"`]([^'"`]*?)['"`]/g;
      const matches = [...contents.matchAll(pattern)];
      for (const m of matches) {
        const text = m[1];
        expect(text.toLowerCase()).not.toContain('partner');
      }
    });
  }
});
