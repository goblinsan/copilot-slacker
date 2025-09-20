/**
 * Simple in-memory token bucket rate limiter per key (e.g., IP address).
 * Responsibility: Provide isAllowed(key) that enforces capacity per interval.
 * Env overrides: RATE_LIMIT_CAPACITY (default 30), RATE_LIMIT_REFILL_PER_SEC (default 1).
 * Non-goals: Distributed coordination (Redis variant in future), precision (approximate timers ok).
 */

interface Bucket { tokens: number; last: number; }
const buckets = new Map<string, Bucket>();

let capacity = Number(process.env.RATE_LIMIT_CAPACITY || 30);
let refillPerSec = Number(process.env.RATE_LIMIT_REFILL_PER_SEC || 1);

export function isAllowed(key: string): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { tokens: capacity, last: now }; buckets.set(key,b); }
  // Refill
  const elapsedSec = (now - b.last)/1000;
  if (elapsedSec > 0) {
    b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
    b.last = now;
  }
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return true;
  }
  return false;
}

export function clearRateLimits() { buckets.clear(); }

export function configureRateLimit(newCapacity?: number, newRefillPerSec?: number) {
  if (typeof newCapacity === 'number') capacity = newCapacity;
  if (typeof newRefillPerSec === 'number') newRefillPerSec >= 0 && (refillPerSec = newRefillPerSec);
  clearRateLimits();
}
