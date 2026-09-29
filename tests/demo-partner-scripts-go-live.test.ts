import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// M3-21 review: the demo partner scripts create/promote partners outside the wizard. Like the wizard,
// they must approve go-live for those partners, or a partner-scoped admin of a demo partner could not
// hold a live key (partner-go-live-repo.ts). The scripts run main() at import, so this is a static pin.
const src = (f: string) => readFileSync(join(process.cwd(), 'scripts', f), 'utf8');

describe('demo partner scripts approve go-live', () => {
  for (const f of ['seed-demo-partners.ts', 'promote-demo-partners.ts']) {
    it(`${f} upserts an approved go-live row for each partner it writes`, () => {
      const s = src(f);
      expect(s).toMatch(/import \{[^}]*upsertApprovedGoLive[^}]*\} from '@\/db\/repos\/partner-go-live-repo'/);
      expect(s).toMatch(/await upsertApprovedGoLive\(\s*db,\s*id,\s*'system:[a-z-]+'\s*\)/);
    });
  }
});
