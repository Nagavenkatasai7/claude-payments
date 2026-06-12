-- Snapshot catch-up (CI migration-drift gate): migrations 0002-0004 were
-- handwritten without drizzle-kit snapshots, so the snapshot chain was stale.
-- This migration intentionally executes NOTHING — its DDL already shipped in
-- 0002_partner_rates / 0003_funding_refunds / 0004_tickets. It exists solely
-- so drizzle/meta/0005_snapshot.json brings the snapshot chain current and
-- `drizzle-kit generate` is a no-op on a clean tree (the ci drift check).
SELECT 1;
