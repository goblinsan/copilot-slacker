import { describe, it, expect, beforeAll } from 'vitest';
import './approval.test.js'; // ensure vitest environment (side-effect ok)
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { applyApproval } from '../src/approval.js';
import type { GuardRequestRecord } from '../src/types.js';

// Helper to build a request record (without id) consistent with Store.createRequest contract.
function build(min_approvals = 2, allowed: string[] = ['U1','U2']): Omit<GuardRequestRecord,'id'> {
  const now = new Date().toISOString();
  return {
    token: 'tok-multi',
    action: 'test_action',
    payload_hash: 'hash',
    redacted_params: {},
    meta: { origin: { repo: 'demo' }, requester: { id: 'agent', source: 'agent' }, justification: 'multi approval test' },
    status: 'ready_for_approval',
    min_approvals,
    approvals_count: 0,
    required_personas: [],
    persona_state: {},
    allowed_approver_ids: allowed,
    expires_at: new Date(Date.now() + 60000).toISOString(),
    created_at: now,
    policy_hash: 'p'
  };
}

let baseURL: string;
beforeAll(async () => {
  const port = await startServer(0); // ephemeral
  baseURL = `http://localhost:${port}`;
});

describe('Distinct multi-approval tracking (item #2)', () => {
  it('exposes approver IDs in wait response after quorum', async () => {
    const rec = Store.createRequest(build(2, ['U1','U2','U3']));
    const a1 = applyApproval(rec, 'U1');
    expect(a1.ok).toBe(true);
    expect(rec.status).toBe('ready_for_approval');
    const a2 = applyApproval(rec, 'U2');
    expect(a2.ok).toBe(true);
    expect(rec.status).toBe('approved');
    // Allow a brief tick in case async operations would occur (none currently)
    await new Promise(r => setTimeout(r, 10));
  const resp = await fetch(`${baseURL}/api/guard/wait?token=${rec.token}`);
    const json = await resp.json();
    expect(json.status).toBe('approved');
    expect(json.approvers).toContain('U1');
    expect(json.approvers).toContain('U2');
    expect(json.approvers.length).toBe(2);
  });

  it('rejects additional approvals after terminal state', () => {
    const rec = Store.createRequest(build(1, ['U1','U2']));
    const first = applyApproval(rec, 'U1');
    expect(first.ok).toBe(true);
    expect(rec.status).toBe('approved');
    const second = applyApproval(rec, 'U2');
    expect(second.ok).toBe(false);
    // Approvals count should remain 1
    expect(rec.approvals_count).toBe(1);
  });
});
