/**
 * waitFor: Polls a predicate or async function until it returns truthy (or a non-error value)
 * within the provided timeout. Designed to reduce flakiness for scheduler / async eventual consistency tests.
 * Non-goals: high precision timing; use for coarse readiness checks only.
 */
export interface WaitForOptions {
  timeoutMs?: number; // total time to wait (default 2000)
  intervalMs?: number; // polling interval (default 40)
  description?: string; // helpful context for error messages
}

export async function waitFor<T>(fn: () => T | Promise<T>, opts: WaitForOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 40;
  const start = Date.now();
  let lastErr: unknown;
  while (true) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() - start >= timeoutMs) {
      const desc = opts.description ? ` (${opts.description})` : '';
      const detail = lastErr ? `; last error: ${String(lastErr)}` : '';
      throw new Error(`waitFor timeout after ${timeoutMs}ms${desc}${detail}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}
