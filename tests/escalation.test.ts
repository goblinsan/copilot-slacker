import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { startScheduler } from '../src/scheduler.js';
import type { GuardRequestRecord } from '../src/types.js';

// Build a request with explicit escalation threshold ~ half of timeout
function buildEscalating(timeoutMs = 400, escalateBeforeMs = 200): Omit<GuardRequestRecord,'id'> {
  const now = new Date();
  return {
    token: 'tok-escalate-'+Math.random().toString(36).slice(2),
    action: 'escalating_action',
    payload_hash: 'h',
    redacted_params: {},
    meta: { origin: { repo: 'demo' }, requester: { id: 'agent', source: 'agent' }, justification: 'escalation test' },
    status: 'ready_for_approval',
    min_approvals: 1,
    approvals_count: 0,
    required_personas: [],
    persona_state: {},
    allowed_approver_ids: ['U1'],
    expires_at: new Date(now.getTime() + timeoutMs).toISOString(),
    escalate_at: new Date(now.getTime() + timeoutMs - escalateBeforeMs).toISOString(),
    escalation_channel: undefined,
    escalation_fired: false,
    created_at: now.toISOString(),
    policy_hash: 'p'
  };
}

let baseURL: string;
beforeAll(async () => {
  const port = await startServer(0);
  baseURL = `http://localhost:${port}`;
  startScheduler(25);
});

describe('Escalation scheduler', () => {
  it('fires escalation before expiration then expires', async () => {
    const rec = await Store.createRequest(buildEscalating(350,150));
    // Wait until after escalation threshold but before expiration
    await new Promise(r => setTimeout(r, 250));
    const mid = await Store.getById(rec.id);
    expect(mid?.escalation_fired).toBe(true);
    expect(['ready_for_approval','approved','denied','expired']).toContain(mid?.status);
    // Wait for expiration
    await new Promise(r => setTimeout(r, 300));
    const end = await Store.getById(rec.id);
    expect(end?.status).toBe('expired');
  });
});
