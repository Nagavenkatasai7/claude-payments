import type { Instrumentation } from 'next';

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

// Program-Fix 26 (obs-01): every server error Next captures is logged as one
// scrubbed JSON line and, when SENTRY_DSN is set, sent to Sentry by plain fetch
// (src/lib/error-report.ts). Only the allowlisted, scrubbed report leaves: never
// request.path (it can hold pay/verify/reset tokens), headers, err.stack or
// err.cause. Contract: node_modules/next/dist/server/instrumentation/types.d.ts
// (InstrumentationOnRequestError) and the instrumentation.md "onRequestError"
// section — async work is awaited. It can never throw into the request path.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  try {
    const { buildErrorReport, reportRequestError } = await import('@/lib/error-report');
    const { logError } = await import('@/lib/log');
    const report = buildErrorReport(err, request, context);
    logError('request.error', report.message, {
      type: report.type,
      digest: report.digest,
      routePath: report.routePath,
      routeType: report.routeType,
      method: report.method,
    });
    await reportRequestError(report);
  } catch {
    // Observability must never become the outage.
  }
};
