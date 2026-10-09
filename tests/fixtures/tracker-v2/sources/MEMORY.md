# Project memory (synthetic fixture for tests/tracker-seed.test.ts; invented content)

## STATUS
- Widget launch: PR #901 merged and the widget is live in production since the January deploy.
- Gadget sync: PR #902 is open; the gadget sync waits for the owner to pick a retry policy.
- Ledger rebuild: the ledger rebuild is in progress in its own thread.

## OPEN OWNER ITEMS
- Set the gadget API key in the hosting settings so the gadget sync can call the partner sandbox.
- Approve the retry policy for gadget sync (three tries or five tries).

## DECISIONS
- 2026-01-12 10:05Z owner: use the blue theme for the widget page. The owner said "blue theme, ship it".

## KNOWN BUGS
- The widget badge renders one pixel too low on small phones.

## DONE
- The owner rotated the widget signing key on 2026-01-13 and confirmed the new key works.
