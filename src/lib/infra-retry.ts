// infra-retry — ONE bounded retry of a read that hit an infrastructure blip
// (isInfraError: DNS, network, Upstash gateway / capacity, Neon connection).
// The shared Upstash client already retries fetch-level failures itself
// (src/lib/redis.ts); this adds one fresh attempt for what it does not retry
// (an HTTP 5xx / non-JSON gateway body, a capacity UpstashError).
//
// IDEMPOTENT READS ONLY. Never wrap a getdel / consume / incr / OTP issue or
// verify / idempotency claim: a retried write can apply twice.
import { isInfraError } from './infra-error';

export const INFRA_RETRY_DELAY_MS = 200;

/** Run `read`; on an infra error wait `delayMs` and run it once more (a second failure propagates). Non-infra errors are rethrown at once. */
export async function retryOnceOnInfra<T>(read: () => Promise<T>, delayMs = INFRA_RETRY_DELAY_MS): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (!isInfraError(err)) throw err;
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return read();
}
