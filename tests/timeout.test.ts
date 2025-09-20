import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import type { GuardRequestRecord } from '../src/types.js';
import { startScheduler } from '../src/scheduler.js';
import { waitFor } from './utils/waitFor.js';

function buildShort(timeoutMs = 200): Omit<GuardRequestRecord,'id'> {
  const now = new Date();
  return {
    token: 'tok-timeout-'+Math.random().toString(36).slice(2),
    action: 'short_timeout',
    payload_hash: 'h',
    redacted_params: {},
    meta: { origin: { repo: 'demo' }, requester: { id: 'agent', source: 'agent' }, justification: 'short timeout' },
    status: 'ready_for_approval',
    min_approvals: 1,
    approvals_count: 0,
    required_personas: [],
    persona_state: {},
    allowed_approver_ids: ['U1'],
    expires_at: new Date(now.getTime() + timeoutMs).toISOString(),
    created_at: now.toISOString(),
    policy_hash: 'p'
  };
}

let baseURL: string;
beforeAll(async () => {
  const port = await startServer(0);
  baseURL = `http://localhost:${port}`;
  // Use very short interval for deterministic test
  startScheduler(25);
});

describe('Timeout scheduler', () => {
  it('expires request after ttl', async () => {
    const rec = await Store.createRequest(buildShort(120));
    expect(rec.status).toBe('ready_for_approval');
    const json = await waitFor(async () => {
      const resp = await fetch(`${baseURL}/api/guard/wait?token=${rec.token}`);
      const data = await resp.json();
      return data.status === 'expired' ? data : null;
    }, { timeoutMs: 1500, intervalMs: 50, description: 'waiting for expiration' });
    expect(json.status).toBe('expired');
    expect(json.decidedAt).toBeTruthy();
  });
});