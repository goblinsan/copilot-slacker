import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

/**
 * Redis integration test (skips if REDIS_URL not provided or connection fails).
 * Verifies create → updateStatus → approval count → lineage listing persists across a fresh import of store.
 */

let available = true;

beforeAll(async () => {
  if (!process.env.REDIS_URL) {
    available = false; return;
  }
  try {
    // Attempt a lightweight import which connects during createRedisStore
    const { Store } = await import('../src/store.js');
    // Touch store to ensure connection established
    await Store.listOpenRequests?.();
  } catch (e) {
    available = false;
  }
});

beforeEach(()=>{
  process.env.VITEST = '1';
  if (!process.env.REDIS_URL) available = false;
});

describe('redis store integration', () => {
  it.skipIf(!available)('performs CRUD and lineage operations', async () => {
    const { Store } = await import('../src/store.js');
    // Create two related requests (lineage)
    const baseReq = await Store.createRequest({
      token: 't1', action:'deploy', payload_hash:'h1', redacted_params:{a:1}, meta:{ origin:{repo:'r'}, requester:{id:'u',source:'agent'} , justification:'j'}, status:'ready_for_approval', min_approvals:1, approvals_count:0, required_personas:[], persona_state:{}, allowed_approver_ids:['U1'], expires_at: new Date(Date.now()+60000).toISOString(), created_at: new Date().toISOString(), policy_hash:'ph', allow_param_overrides:false, override_keys:[]
    });
    const second = await Store.createRequest({
      token: 't2', action:'deploy', payload_hash:'h2', redacted_params:{a:2}, meta:{ origin:{repo:'r'}, requester:{id:'u',source:'agent'} , justification:'j2'}, status:'ready_for_approval', min_approvals:1, approvals_count:0, required_personas:[], persona_state:{}, allowed_approver_ids:['U1'], expires_at: new Date(Date.now()+60000).toISOString(), created_at: new Date().toISOString(), policy_hash:'ph', lineage_id: baseReq.id, allow_param_overrides:false, override_keys:[]
    });

    // Update status of first to approved
    await Store.updateStatus(baseReq.id, ['ready_for_approval'], 'approved');

    // Add approval record to second
    await Store.addApproval({ id:'ap1', request_id: second.id, actor_slack_id:'U1', actor_type:'human', decision:'approved', created_at: new Date().toISOString() });

    const approvals = await Store.listApprovals(second.id);
    expect(approvals.length).toBe(1);

    // Re-import store to simulate fresh instance (only meaningful if redis backend)
    const fresh = await import('../src/store.js');
    const again = await fresh.Store.getById(baseReq.id);
    expect(again?.status).toBe('approved');

    const lineage = await fresh.Store.listLineageRequests?.(baseReq.id) || [];
    expect(lineage.some(r => r.id === second.id)).toBe(true);
  });
});
