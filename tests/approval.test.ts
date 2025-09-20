import { describe, it, expect } from 'vitest';
import { applyApproval } from '../src/approval.js';
import { Store } from '../src/store.js';
import type { GuardRequestRecord } from '../src/types.js';

// Build helper excluding id (store assigns) to satisfy Store.createRequest signature.
function build(overrides: Partial<Omit<GuardRequestRecord,'id'>> = {}): Omit<GuardRequestRecord,'id'> {
  return {
    token: 'tok', action: 'test', payload_hash: 'h', redacted_params: {},
    meta: { origin: { repo: 'demo' }, requester: { id: 'agent', source: 'agent' }, justification: 'test' },
    status: 'ready_for_approval', min_approvals: 2, approvals_count: 0,
    required_personas: [], persona_state: {}, allowed_approver_ids: ['U1','U2'],
    expires_at: new Date().toISOString(), created_at: new Date().toISOString(), policy_hash: 'p',
    ...overrides
  };
}

describe('applyApproval', () => {
  it('rejects unauthorized actor', async () => {
    const r = await Store.createRequest(build());
    const res = applyApproval(r, 'UNAUTH');
    expect(res.ok).toBe(false);
  });
  it('approves after quorum', async () => {
    const r = await Store.createRequest(build());
    const a1 = applyApproval(r, 'U1');
    expect(a1.ok).toBe(true);
    expect(r.status).toBe('ready_for_approval');
    const a2 = applyApproval(r, 'U2');
    expect(a2.ok).toBe(true);
    expect(r.status).toBe('approved');
  });
  it('prevents duplicate approval', async () => {
    const r = await Store.createRequest(build());
    applyApproval(r, 'U1');
    const dup = applyApproval(r, 'U1');
    expect(dup.ok).toBe(false);
  });
  it('tracks distinct approvers count accurately', async () => {
    const r = await Store.createRequest(build());
    expect(r.approvals_count).toBe(0);
    applyApproval(r, 'U1');
    expect(r.approvals_count).toBe(1);
    applyApproval(r, 'U2');
    expect(r.approvals_count).toBe(2);
  });
  it('approves immediately and maintains invariant when min_approvals=1', async () => {
    const r = await Store.createRequest(build({ min_approvals: 1 }));
    expect(r.approvals_count).toBe(0);
    const res = applyApproval(r, 'U1');
    expect(res.ok).toBe(true);
    // Should be terminal
    expect(r.status).toBe('approved');
    expect(r.approvals_count).toBe(1);
  });
});