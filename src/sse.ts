import { Store } from './store.js';
import { getOptimisticActors } from './approval.js';

/**
 * Lightweight in-memory SSE subscription manager (sufficient for single-instance).
 * Responsibility: track per-token listeners, emit current state snapshot, manage heartbeats & cleanup.
 * Non-goals: clustering, persistence, replay after restart.
 */

interface Listener {
  token: string;
  res: import('node:http').ServerResponse;
  heartbeatTimer: NodeJS.Timeout;
}

const listeners = new Map<string, Listener>(); // key = token

export function addListener(token: string, res: import('node:http').ServerResponse) {
  removeListener(token); // ensure single
  const listener: Listener = { token, res, heartbeatTimer: setInterval(()=> sendEvent(res,'heartbeat',''), 25000) };
  listeners.set(token, listener);
}

export function removeListener(token: string) {
  const l = listeners.get(token); if(!l) return;
  clearInterval(l.heartbeatTimer);
  try { l.res.end(); } catch {}
  listeners.delete(token);
}

export async function emitState(token: string) {
  const l = listeners.get(token); if(!l) return;
  const record = await Store.getByToken(token);
  if (!record) { sendEvent(l.res,'state', JSON.stringify({ status:'expired'})); removeListener(token); return; }
  const persisted = await Store.approvalsFor(record.id);
  const optimistic = getOptimisticActors(record.id);
  const approvers = Array.from(new Set([...(persisted||[]), ...optimistic]));
  sendEvent(l.res,'state', JSON.stringify({ status: record.status, approvers, decidedAt: record.decided_at }));
  if(['approved','denied','expired'].includes(record.status)) {
    // Defer removal to next tick to allow the event to flush to the client
    setImmediate(() => removeListener(token));
  }
}

export async function broadcastForRequestId(requestId: string) {
  for (const l of listeners.values()) {
    const maybe = await Promise.resolve(Store.getByToken(l.token));
    if (maybe && maybe.id === requestId) {
      void emitState(l.token);
    }
  }
}

export function sendEvent(res: import('node:http').ServerResponse, event: string, data: string) {
  res.write(`event: ${event}\n`);
  if (data) res.write(`data: ${data}\n`);
  res.write('\n');
}

// Cleanup on process exit
process.on('exit', () => { for (const t of [...listeners.keys()]) removeListener(t); });