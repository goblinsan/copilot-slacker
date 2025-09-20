/**
 * Replay guard for Slack interaction signatures.
 * Responsibility: Track recently seen (timestamp, signature) pairs and reject replays within TTL.
 * Non-goals: Distributed coordination (use Redis variant later), persistence across restarts.
 */

interface Entry { expires: number; }

const ttlMs = 5 * 60 * 1000; // 5 minutes
const seen = new Map<string, Entry>();

function sweep() {
  const now = Date.now();
  for (const [k,v] of seen.entries()) if (v.expires <= now) seen.delete(k);
}
setInterval(sweep, 60_000).unref();

export function markAndCheckReplay(signature: string, timestamp: string): boolean {
  const key = `${timestamp}:${signature}`;
  const now = Date.now();
  sweep();
  if (seen.has(key)) return true; // replay
  seen.set(key, { expires: now + ttlMs });
  return false;
}

export function clearReplayCache() { seen.clear(); }
