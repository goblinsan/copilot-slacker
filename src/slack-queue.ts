/**
 * Slack update queue with coalescing & simple 429 backoff.
 * Enabled via SLACK_UPDATE_QUEUE=true. Coalesces multiple updates for the same (channel,ts)
 * and only sends the latest payload. Basic backoff uses exponential wait with jitter when
 * a 429 (rate_limited) style error is detected in response error string.
 */
import { slackClient } from './slack.js';

type UpdatePayload = { channel: string; ts: string; body: any };
interface QueueItem { key: string; payload: UpdatePayload; attempts: number; }

const queue = new Map<string, QueueItem>(); // key -> latest item
let draining = false;
let scheduled = false; // whether a drain has been scheduled (debounce window)

function baseDelay() { return Number(process.env.SLACK_RATE_BASE_DELAY_MS || 300); }
function jitterMs() { return Number(process.env.SLACK_RATE_JITTER_MS || 150); }
function debounceDelay() { return Number(process.env.SLACK_QUEUE_DEBOUNCE_MS || 25); }

export function enqueueUpdate(channel: string, ts: string, body: any) {
  const key = `${channel}:${ts}`;
  const existing = queue.get(key);
  if (existing) {
    existing.payload = { channel, ts, body }; // coalesce
  } else {
    queue.set(key, { key, payload: { channel, ts, body }, attempts: 0 });
  }
  // If drain not active and not yet scheduled, schedule with small debounce window to allow coalescing
  if (!draining && !scheduled) {
    scheduled = true;
    setTimeout(() => { if (!draining) drain(); }, debounceDelay());
  }
}

async function drain() {
  scheduled = false;
  draining = true;
  while (queue.size) {
    // FIFO-ish but Map insertion order is preserved for new keys; we always overwrite existing.
    const [key, item] = queue.entries().next().value as [string, QueueItem];
    queue.delete(key);
    try {
      await slackClient.chat.update({
        channel: item.payload.channel,
        ts: item.payload.ts,
        ...item.payload.body
      });
      // success
    } catch (e: any) {
      const msg = String(e?.data?.error || e?.message || e);
      if (/rate.*limit/i.test(msg) || msg.includes('ratelimited')) {
        // Re-queue with backoff
        item.attempts += 1;
        const delay = Math.min(5000, baseDelay() * Math.pow(2, item.attempts - 1)) + Math.random() * jitterMs();
        queue.set(key, item); // put back
        await new Promise(r => setTimeout(r, delay));
        continue; // attempt again (will pick same item first next loop)
      }
      // Non-rate error: drop silently (could add audit event later)
    }
    // small micro-delay to allow additional coalescing batches
    if (queue.size) await new Promise(r => setTimeout(r, 10));
  }
  draining = false;
}

export function queueSize() { return queue.size; }
export function clearQueue() { queue.clear(); }