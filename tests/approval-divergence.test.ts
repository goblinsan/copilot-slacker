import { describe, it, expect, beforeEach } from 'vitest';
import { Store, __TEST_clearStore } from '../src/store.js';
import { applyApproval } from '../src/approval.js';

/**
 * Regression test: simulate reference divergence by cloning the request object structure
 * (e.g., what would happen if an upstream layer serialized/deserialized) and then calling applyApproval
 * with the clone. The implementation should adopt the canonical store record and still approve.
 */

describe('approval divergence adoption', () => {
  beforeEach(() => { process.env.VITEST = '1'; __TEST_clearStore(); });
  it('adopts canonical request and increments count when passed a cloned reference', async () => {
    const rec: any = await Store.createRequest({
      token: 't1',
      action: 'demo',
      payload_hash: 'h',
      redacted_params: { a: 1 },
  meta: { origin: { repo: 'x' }, requester: { id: 'U1', source: 'slack' }, justification: 'test' },
      status: 'ready_for_approval',
      min_approvals: 1,
      approvals_count: 0,
      required_personas: [],
      persona_state: {},
      allowed_approver_ids: ['U1'],
      expires_at: new Date(Date.now()+60000).toISOString(),
      escalate_at: undefined,
      escalation_channel: undefined,
      escalation_fired: false,
      created_at: new Date().toISOString(),
      policy_hash: 'ph',
      allow_param_overrides: false,
      override_keys: []
    });
    // Shallow clone (break object identity)
    const clone = { ...rec };
    // Apply approval using clone
    const result = applyApproval(clone, 'U1');
    expect(result.ok).toBe(true);
    // Canonical store record should reflect approval
  const fresh: any = await Store.getById(rec.id);
    expect(fresh?.approvals_count).toBe(1);
    expect(fresh?.status).toBe('approved');
  });
});
