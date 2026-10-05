// deploy-alert — the ops alerts that GitHub workflows raise about a release
// (Release safety Batch 2 part B). A workflow cannot reach WhatsApp itself, so
// it POSTs one of a few FIXED kinds to /api/ops/deploy-alert (Bearer
// CRON_SECRET). Nothing the caller sends becomes free text: the kind picks a
// fixed sentence, and the only values put in it are commit SHAs and a
// deployment id that must match strict patterns. Each alert has a dedupe key,
// so a re-run of the same workflow sends it once.

export const DEPLOY_ALERT_KINDS = ['release_check_failed', 'rollback_done', 'rollback_failed'] as const;
export type DeployAlertKind = (typeof DEPLOY_ALERT_KINDS)[number];

const SHA = /^[0-9a-f]{7,40}$/;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{6,64}$/;
const RUN_ID = /^[0-9]{1,20}$/;

export interface DeployAlert {
  message: string;
  dedupeKey: string;
}

function sha(v: unknown): string | null {
  return typeof v === 'string' && SHA.test(v) ? v.slice(0, 7) : null;
}

/** Validate a workflow's body and build the alert, or return null (the route's 400). */
export function buildDeployAlert(body: unknown): DeployAlert | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const kind = b.kind;
  if (typeof kind !== 'string' || !(DEPLOY_ALERT_KINDS as readonly string[]).includes(kind)) return null;
  const run = typeof b.runId === 'string' && RUN_ID.test(b.runId) ? b.runId : null;
  const runText = run ? ` GitHub run ${run}.` : '';

  if (kind === 'release_check_failed') {
    const s = sha(b.sha);
    const dpl = typeof b.deploymentId === 'string' && DEPLOYMENT_ID.test(b.deploymentId) ? b.deploymentId : null;
    if (!s) return null;
    return {
      message:
        `🛑 SmartRemit release: the synthetic sandbox transfer FAILED on build ${s}. ` +
        `The build stays held; customers stay on the previous build.${runText} See the GitHub issue.`,
      dedupeKey: `deploy:release_check_failed:${s}:${dpl ?? '-'}`,
    };
  }

  const from = sha(b.fromSha);
  const to = sha(b.toSha);
  if (!from) return null;
  if (kind === 'rollback_done') {
    if (!to) return null;
    return {
      message:
        `⏪ SmartRemit release: build ${from} failed the post-release money or health check. ` +
        `Production is rolled back to build ${to}. New merges do not go live until a person promotes one.${runText} See the GitHub issue.`,
      dedupeKey: `deploy:rollback_done:${from}`,
    };
  }
  return {
    message:
      `🛑 SmartRemit release: build ${from} failed the post-release money or health check, ` +
      `and the automatic rollback FAILED. Roll back by hand now (docs/ROLLBACK.md).${runText}`,
    dedupeKey: `deploy:rollback_failed:${from}`,
  };
}
