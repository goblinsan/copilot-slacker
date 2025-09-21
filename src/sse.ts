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
const debug = process.env.SSE_DEBUG === '1';

export function addListener(token: string, res: import('node:http').ServerResponse) {
  removeListener(token); // ensure single
  const listener: Listener = { token, res, heartbeatTimer: setInterval(()=> sendEvent(res,'heartbeat',''), 25000) };
  listeners.set(token, listener);
  if (debug) console.log('[sse] addListener', token, 'listeners:', listeners.size);
}

export function removeListener(token: string) {
  const l = listeners.get(token); if(!l) return;
  clearInterval(l.heartbeatTimer);
  try { l.res.end(); } catch {}
  listeners.delete(token);
  if (debug) console.log('[sse] removeListener', token, 'remaining:', listeners.size);
}

export async function emitState(token: string) {
  const l = listeners.get(token); if(!l) { if (debug) console.log('[sse] emitState skip (no listener)', token); return; }
  const record = await Store.getByToken(token);
  if (!record) { sendEvent(l.res,'state', JSON.stringify({ status:'expired'})); if (debug) console.log('[sse] emitState expired', token); removeListener(token); return; }
  const persisted = await Store.approvalsFor(record.id);
  const optimistic = getOptimisticActors(record.id);
  const approvers = Array.from(new Set([...(persisted||[]), ...optimistic]));
  if (debug) console.log('[sse] emitState', token, 'status:', record.status, 'approvers:', approvers);
  sendEvent(l.res,'state', JSON.stringify({ status: record.status, approvers, decidedAt: record.decided_at }));
  if(['approved','denied','expired'].includes(record.status)) {
    if (debug) console.log('[sse] terminal state, scheduling removeListener', token);
    // Defer removal to next tick to allow the event to flush to the client
    setImmediate(() => removeListener(token));
  }
}

export async function broadcastForRequestId(requestId: string) {
  if (debug) console.log('[sse] broadcastForRequestId', requestId, 'listeners:', listeners.size);
  for (const l of listeners.values()) {
    const maybe = await Promise.resolve(Store.getByToken(l.token));
    if (maybe && maybe.id === requestId) {
      if (debug) console.log('[sse] broadcasting to token', l.token);
      void emitState(l.token);
    } else if (debug) {
      console.log('[sse] skipping token', l.token, 'no match');
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