import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { startScheduler } from '../src/scheduler.js';
import crypto from 'node:crypto';
import type { GuardRequestRecord } from '../src/types.js';
import { applyApproval } from '../src/approval.js';

// Simulate a policy where base min approvals=1 but escalation raises to 2 before expiry.
function buildEscalatingQuorum(timeoutMs=400, escalateBeforeMs=200): Omit<GuardRequestRecord,'id'> {
  const now = new Date();
  return {
    token: 'tok-quorum-'+Math.random().toString(36).slice(2),
    action: 'quorum_action',
    payload_hash: crypto.randomUUID(),
    redacted_params: {},
    meta: { origin: { repo: 'demo' }, requester: { id: 'agent', source: 'agent' }, justification: 'quorum escalation test' },
    status: 'ready_for_approval',
    min_approvals: 1,
    escalate_min_approvals: 2,
    approvals_count: 0,
    required_personas: [],
    persona_state: {},
    allowed_approver_ids: ['U1','U2'],
    expires_at: new Date(now.getTime() + timeoutMs).toISOString(),
    escalate_at: new Date(now.getTime() + timeoutMs - escalateBeforeMs).toISOString(),
    escalation_channel: undefined,
    escalation_fired: false,
    created_at: now.toISOString(),
    policy_hash: 'p'
  };
}

let ready=false;
beforeAll(async () => {
  const port = await startServer(0); // ephemeral
  startScheduler(25);
  ready = true;
});

describe('Escalate quorum', () => {
  it('raises min approvals after escalation', async () => {
    if(!ready) throw new Error('server not ready');
    const rec = await Store.createRequest(buildEscalatingQuorum());
    // Approve once before escalation
    const r1 = await Store.getById(rec.id);
    if(!r1) throw new Error('missing');
    const a1 = applyApproval(r1,'U1');
    expect(a1.ok).toBe(true);
    expect(r1.status).toBe('approved'); // base min=1 triggers approval immediately
    // Reset scenario: create another where we approve after escalation raises threshold
    const rec2 = await Store.createRequest(buildEscalatingQuorum());
    // Wait past escalation threshold
    await new Promise(r=>setTimeout(r,250));
    const mid = await Store.getById(rec2.id);
    expect(mid?.escalation_fired).toBe(true);
    expect(mid?.min_approvals).toBe(2);
    // First approval should not finalize now
    const a2 = applyApproval(mid!,'U1');
    expect(a2.ok).toBe(true);
    expect(mid?.status).toBe('ready_for_approval');
    // Second approval finalizes
    const a3 = applyApproval(mid!,'U2');
    expect(a3.ok).toBe(true);
    expect(mid?.status).toBe('approved');
  });
});
