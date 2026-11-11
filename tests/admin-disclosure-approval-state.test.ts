import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DisclosureApprovalState } from '@/app/admin-dashboard/partners/disclosure-approval-state';
import { resolvePartnerDisclosure } from '@/lib/partner-config';
import type { PartnerDisclosureConfig } from '@/lib/types';
import { approvedDisclosureConfig } from './helpers-live';

// Fix pack 4 T6 (C23): the admin partner page's provider-block approval state and the pre-save
// warning. The disclosure card sits in a Radix Tabs panel a static render of the page does not
// show, so the component is rendered on its own here (like LiveCertificationCard).

const WARNING =
  "This partner is certified for live money. Saving here clears the partner's approval, and its payments stop until a partner admin with two-step sign-in approves the block again.";
const NOTE = 'A SmartRemit save never approves this block; it clears an existing approval.';

const decode = (h: string) => h.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const html = (o: { id?: string; disclosure?: PartnerDisclosureConfig; certified?: boolean } = {}) => {
  const p = { id: o.id ?? 'acme', supportConfig: o.disclosure ? { disclosure: o.disclosure } : {} };
  return decode(
    renderToStaticMarkup(
      DisclosureApprovalState({ shown: resolvePartnerDisclosure(p), approval: o.disclosure?.approval, certified: o.certified ?? false }),
    ),
  );
};
const unapproved = (): PartnerDisclosureConfig => {
  const { approval: _a, ...block } = approvedDisclosureConfig();
  void _a;
  return block;
};

describe('DisclosureApprovalState (admin partner page, pack 4)', () => {
  it("approved -> 'Approved by <by> on <date>'", () => {
    const cfg = approvedDisclosureConfig();
    const h = html({ disclosure: cfg });
    expect(h).toContain('data-testid="disclosure-approval-state"');
    expect(h).toContain('data-approved="true"');
    expect(h).toContain(`Approved by test-partner-admin on ${cfg.approval!.at.slice(0, 10)}`);
    expect(h).not.toContain('Not approved');
  });

  it("not approved -> 'Not approved' (no stamp, or a stamp a later edit made stale)", () => {
    const h = html({ disclosure: unapproved() });
    expect(h).toContain('data-approved="false"');
    expect(h).toContain('Not approved');
    expect(h).not.toContain('Approved by');
    const stale = html({ disclosure: { ...approvedDisclosureConfig(), phone: '+1 800 555 0111' } });
    expect(stale).toContain('Not approved');
    expect(stale).not.toContain('Approved by');
  });

  it('certified partner -> the pre-save warning (data-testid="disclosure-platform-warning")', () => {
    const h = html({ disclosure: approvedDisclosureConfig(), certified: true });
    expect(h).toContain('data-testid="disclosure-platform-warning"');
    expect(h).toContain(WARNING);
    expect(h).toContain(NOTE);
  });

  it("uncertified -> no warning, but the 'SmartRemit save never approves' note", () => {
    const h = html({ disclosure: approvedDisclosureConfig(), certified: false });
    expect(h).not.toContain('disclosure-platform-warning');
    expect(h).not.toContain(WARNING);
    expect(h).toContain(NOTE);
  });

  it('demo/default -> no approval line (nothing rendered, even certified with an approved block)', () => {
    expect(html({ id: 'default', disclosure: approvedDisclosureConfig(), certified: true })).toBe('');
  });

  it('escapes the approver username', () => {
    const cfg = approvedDisclosureConfig();
    const h = renderToStaticMarkup(
      DisclosureApprovalState({
        shown: resolvePartnerDisclosure({ id: 'acme', supportConfig: { disclosure: cfg } }),
        approval: { ...cfg.approval!, by: '<b>x</b>' },
        certified: false,
      }),
    );
    expect(h).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(h).not.toContain('<b>x</b>');
  });
});
