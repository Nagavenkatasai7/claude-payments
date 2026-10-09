<!--
Change record for every PR (SOC 2 CC8.1, PCI DSS 6.5.2). Fill in each section;
write "None" where a section does not apply. Never paste secrets, tokens,
phone numbers or customer data here: the repository is public.
-->

## Before

<!-- What a customer, partner or staff member sees today, in plain words. -->

## After

<!-- What they see once this merges. Add one sentence on what the change does if it is not obvious, and a short "How". -->

## Touches money, auth, webhooks, crypto or compliance?

<!-- No, or Yes: name the paths (e.g. src/lib/settlement.ts) and confirm /security-review ran on this branch. -->

## Migration?

<!--
None, additive, or destructive with a reviewed `-- migration-guard: allow-destructive [after-deploy] <reason>` line.
Additive or destructive without after-deploy: the production build applies it (scripts/migrate-on-build.mjs); confirm the current build works with it.
after-deploy: the build does not apply it; say when /migrate-prod runs after the deploy.
-->

## Risk

<!-- What can break, for which customers or partners, and how we would notice. -->

## Rollback

<!-- Instant Rollback (docs/ROLLBACK.md), a revert PR, or a flag switch. Say whether the previous build still works with this PR's data. -->

## Tests run

<!-- The commands and their results (typecheck, lint, vitest files, e2e). -->

Program-Fix: <n>
<!-- Keep the line above only for a fix from the Program Ledger manifest; delete it otherwise. -->
