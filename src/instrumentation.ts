// instrumentation — runs once when a Next.js server instance boots. The one
// job here is the Stage-3 production boot assert: refuse to serve traffic with
// missing money-grade secrets instead of failing open at request time.

export async function register(): Promise<void> {
  const { shouldAssertProductionBoot, productionBootProblems } = await import(
    '@/lib/boot-assert'
  );
  if (!shouldAssertProductionBoot(process.env)) return;
  const problems = productionBootProblems(process.env);
  if (problems.length > 0) {
    // Names only — never values.
    throw new Error(
      `FATAL: production boot blocked — fix the environment and redeploy: ${problems.join('; ')}`,
    );
  }
}
