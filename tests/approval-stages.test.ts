import { describe, it, expect, beforeEach } from 'vitest';
import { Store, __TEST_clearStore } from '../src/store.js';
import { applyApproval } from '../src/approval.js';

// Smoke test ensuring stage diagnostics produce expected ordering when APPROVAL_STAGE_DIAG=1

describe('approval stage diagnostics', () => {
  beforeEach(()=>{ process.env.VITEST='1'; __TEST_clearStore(); process.env.APPROVAL_STAGE_DIAG='1'; delete process.env.APPROVAL_FAST_PATH_DIAG; });
  it('emits sequential stages for single approval', () => {
    const rec: any = Store.createRequest({
      token: 't', action: 'x', payload_hash: 'h', redacted_params: {}, meta: { origin:{repo:'r'}, requester:{id:'U1',source:'slack'}, justification:'j' }, status: 'ready_for_approval', min_approvals:1, approvals_count:0, required_personas:[], persona_state:{}, allowed_approver_ids:['U1'], expires_at: new Date(Date.now()+60000).toISOString(), escalate_at: undefined, escalation_channel: undefined, escalation_fired:false, created_at: new Date().toISOString(), policy_hash:'p', allow_param_overrides:false, override_keys: [] });
    const result = applyApproval(rec,'U1');
    expect(result.ok).toBe(true);
    expect(rec.status).toBe('approved');
  });
});
