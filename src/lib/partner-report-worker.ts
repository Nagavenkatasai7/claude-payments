import type { DbOrTx } from '@/db/client';
import { createPartnerReportRepo, type ReportJobRow } from '@/db/repos/partner-report-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { ctx as cryptoCtx } from '@/lib/crypto-context';
import { decryptField, encryptField } from '@/lib/field-crypto';
import { logWarn } from '@/lib/log';
import {
  FEES_COLUMNS,
  MAX_REPORT_BYTES,
  MAX_REPORT_ROWS,
  REPORT_MIN_BUDGET_MS,
  REPORT_TTL_MS,
  REPORT_WALL_MS,
  TRANSFER_EXPORT_COLUMNS,
  csvHeader,
  csvLine,
  feesMonthlyRows,
  isJobId,
  monthBounds,
  transferExportRow,
  type CsvValue,
} from '@/lib/partner-reports';
import { STATEMENT_COLUMNS, decodeStatementCursor, statementRow, type StatementCursor } from '@/lib/settlement-statement';
import { TRANSFER_STATUSES } from '@/lib/partner-transfers';
import type { TransferStatus } from '@/lib/types';

// partner-report-worker (UI redesign M3-16): the 'partner.report' outbox effect. outbox-worker.ts
// only dispatches here, so the worker file stays a thin switch.
//
// Invariants:
//  - The payload is ONLY { jobId }. The tenant comes from the job row, and every ledger read is
//    tenant-REQUIRED with that row's partner id, so a job can only ever read its own tenant.
//  - Rows come from MASKED reads and pass an allow-list projection (settlements: statementRow;
//    transfers: transferExportRow; fees: aggregates only), then csvCell's formula guard.
//  - The CSV is sealed with field-crypto bound to (tenant, job id); plaintext never hits the DB.
//  - Budget: a job STARTS only with >= REPORT_MIN_BUDGET_MS left before the invocation's hard stop,
//    else ReportDeferredError is thrown BEFORE the claim (drainOnce defers the row uncharged, the
//    job stays queued). A build is boxed by rows, bytes and REPORT_WALL_MS, and flags `truncated`.
//  - Idempotent: a replay finds the job ready/failed/expired and completes without rebuilding. A
//    job 'running' under a fresh claim is a retryable 'report_busy'; a stale claim is reclaimed.
//  - Failure after the claim → failJob with a FIXED code (never an exception message).

/** Thrown before any claim when the invocation cannot fit a report: deferred UNCHARGED. */
export class ReportDeferredError extends Error {
  constructor(readonly delaySec: number = 30) {
    super('report_deferred');
    this.name = 'ReportDeferredError';
  }
}

const PAGE_SIZE = 500;
const ERR_INVALID_PARAMS = 'invalid_params';
const ERR_GENERATION = 'generation_failed';

class InvalidParamsError extends Error {
  constructor() {
    super(ERR_INVALID_PARAMS);
    this.name = 'InvalidParamsError';
  }
}

export interface BuildOpts {
  maxRows?: number;
  maxBytes?: number;
  wallMs?: number;
  pageSize?: number;
  now?: () => number;
}

export interface BuiltReport {
  csv: string;
  rowCount: number;
  truncated: boolean;
}

type JobLike = Pick<ReportJobRow, 'id' | 'partnerId' | 'kind'> & { params: unknown };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function instant(v: unknown): Date {
  const d = typeof v === 'string' ? new Date(v) : null;
  if (!d || isNaN(d.getTime())) throw new InvalidParamsError();
  return d;
}

function windowOf(params: unknown): { from: Date; to: Date } {
  const p = obj(params);
  const from = instant(p.from);
  const to = instant(p.to);
  if (to.getTime() <= from.getTime()) throw new InvalidParamsError();
  return { from, to };
}

/** Accumulates CSV lines under the row, byte and wall-time caps. */
class CsvSink {
  private parts: string[];
  private bytes: number;
  rowCount = 0;
  truncated = false;
  private readonly started: number;

  constructor(
    header: string,
    private readonly o: Required<Pick<BuildOpts, 'maxRows' | 'maxBytes' | 'wallMs' | 'now'>>,
  ) {
    this.parts = [header];
    this.bytes = Buffer.byteLength(header, 'utf8');
    this.started = o.now();
  }

  /** False (and truncated) when the line does not fit. */
  push(line: string): boolean {
    const n = Buffer.byteLength(line, 'utf8');
    if (this.rowCount >= this.o.maxRows || this.bytes + n > this.o.maxBytes) {
      this.truncated = true;
      return false;
    }
    this.parts.push(line);
    this.bytes += n;
    this.rowCount++;
    return true;
  }

  /** Checked between pages: past the wall box with more to read → truncated. */
  outOfTime(): boolean {
    if (this.o.now() - this.started >= this.o.wallMs) {
      this.truncated = true;
      return true;
    }
    return false;
  }

  result(): BuiltReport {
    return { csv: this.parts.join(''), rowCount: this.rowCount, truncated: this.truncated };
  }
}

/** Build the (masked) CSV for one job from its own tenant's ledger. Throws InvalidParamsError on bad params. */
export async function buildReportCsv(db: DbOrTx, job: JobLike, opts: BuildOpts): Promise<BuiltReport> {
  const o = {
    maxRows: opts.maxRows ?? MAX_REPORT_ROWS,
    maxBytes: opts.maxBytes ?? MAX_REPORT_BYTES,
    wallMs: opts.wallMs ?? REPORT_WALL_MS,
    now: opts.now ?? Date.now,
  };
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const partnerId = job.partnerId;

  if (job.kind === 'settlements') {
    const { from, to } = windowOf(job.params);
    const sink = new CsvSink(csvHeader(STATEMENT_COLUMNS), o);
    const repo = createTransferRepo(db);
    let cursor: StatementCursor | null = null;
    for (;;) {
      const page = await repo.listSettledPage(partnerId, from, to, { limit: pageSize, cursor });
      for (const t of page.items) {
        if (!sink.push(csvLine(STATEMENT_COLUMNS, statementRow(t) as Record<string, CsvValue>))) return sink.result();
      }
      if (!page.nextCursor) return sink.result();
      cursor = decodeStatementCursor(page.nextCursor);
      if (!cursor || sink.outOfTime()) return sink.result();
    }
  }

  if (job.kind === 'transfers') {
    const { from, to } = windowOf(job.params);
    const p = obj(job.params);
    const environment = p.environment === 'test' ? 'test' : 'live';
    const status = (TRANSFER_STATUSES as readonly string[]).includes(String(p.status)) ? (p.status as TransferStatus) : undefined;
    const sink = new CsvSink(csvHeader(TRANSFER_EXPORT_COLUMNS), o);
    const repo = createPartnerReportRepo(db);
    let cursor: string | undefined;
    for (;;) {
      const page = await repo.transfersForExport(partnerId, { from, to, environment, status, limit: pageSize, cursor });
      for (const t of page.items) {
        if (!sink.push(csvLine(TRANSFER_EXPORT_COLUMNS, transferExportRow(t)))) return sink.result();
      }
      if (!page.nextCursor || sink.outOfTime()) return sink.result();
      cursor = page.nextCursor;
    }
  }

  if (job.kind === 'fees_monthly') {
    const month = obj(job.params).month;
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new InvalidParamsError();
    const { start, end } = monthBounds(month);
    const sink = new CsvSink(csvHeader(FEES_COLUMNS), o);
    for (const r of feesMonthlyRows(await createPartnerReportRepo(db).feesByDay(partnerId, start, end))) {
      if (!sink.push(csvLine(FEES_COLUMNS, r))) break;
    }
    return sink.result();
  }

  throw new InvalidParamsError();
}

/** Open a ready job's sealed CSV under ITS OWN row's (tenant, id). */
export function openReportCsv(job: Pick<ReportJobRow, 'id' | 'partnerId' | 'contentEnc'>): string {
  if (!job.contentEnc) throw new Error('partner-report: no content');
  return decryptField(job.contentEnc, undefined, cryptoCtx.partnerReport(job.partnerId, job.id));
}

export interface RunOpts extends BuildOpts {
  /** Epoch ms when the worker invocation will be killed (DrainOptions.hardStopAt). */
  hardStopAt?: number;
  /**
   * One per worker INVOCATION (DrainOptions.reportSlot): at most one report is built per
   * invocation, so two back-to-back 15 s builds can never push money rows past the start cutoff.
   */
  slot?: { reportStarted: boolean };
}

export type RunOutcome = 'ready' | 'failed' | 'skipped';

/** The 'partner.report' handler body. Throws ReportDeferredError (uncharged) or a retryable Error. */
export async function runPartnerReportJob(db: DbOrTx, jobId: string, opts: RunOpts = {}): Promise<RunOutcome> {
  if (!isJobId(jobId)) return 'skipped'; // never produced by us; nothing to build
  const now = opts.now ?? Date.now;
  if (opts.hardStopAt !== undefined && opts.hardStopAt - now() < REPORT_MIN_BUDGET_MS) throw new ReportDeferredError();

  if (opts.slot?.reportStarted) throw new ReportDeferredError(5);

  const repo = createPartnerReportRepo(db);
  const job = await repo.claimJob(jobId, new Date(now()));
  if (!job) {
    const st = await repo.getStatus(jobId);
    if (!st || st.status === 'ready' || st.status === 'failed' || st.status === 'expired') return 'skipped';
    // Running under a fresh claim (or locked by a concurrent claimer): retry with backoff.
    throw new Error('report_busy');
  }
  const claimedAt = job.claimedAt!;
  if (opts.slot) opts.slot.reportStarted = true;

  let built: BuiltReport;
  let contentEnc: string;
  try {
    built = await buildReportCsv(db, job, opts);
    contentEnc = encryptField(built.csv, undefined, cryptoCtx.partnerReport(job.partnerId, job.id));
  } catch (err) {
    logWarn('worker.partner-report', 'report build failed', { jobId: job.id, error: err instanceof Error ? err.name : 'error' });
    if (err instanceof InvalidParamsError) {
      await repo.failJob(job.id, claimedAt, ERR_INVALID_PARAMS);
      return 'failed';
    }
    // Anything else may be transient (a dropped connection): hand the job back to queued and let
    // the outbox retry it with backoff. A FIXED message, never the cause (it could echo data).
    // At MAX_ATTEMPTS the row dead-letters (one ops alert) and the job shows as not built.
    await repo.releaseJob(job.id, claimedAt);
    throw new Error(ERR_GENERATION);
  }
  const params = { ...obj(job.params), ...(built.truncated ? { truncated: true } : {}) };
  const ok = await repo.completeJob(job.id, claimedAt, {
    contentEnc,
    rowCount: built.rowCount,
    params,
    expiresAt: new Date(now() + REPORT_TTL_MS),
  });
  if (!ok) logWarn('worker.partner-report', 'completeJob refused: claim no longer ours', { jobId: job.id });
  return ok ? 'ready' : 'skipped';
}
