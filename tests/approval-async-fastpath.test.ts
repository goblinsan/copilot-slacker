import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store, __TEST_clearStore } from '../src/store.js';
import { applyApproval } from '../src/approval.js';

// Async fast-path simulation: monkey-patch addApproval to return a Promise resolving on next tick
// Ensures that optimistic terminal path emits post_add_core_early and persists approved status.

describe('approval async fast-path', () => {
  const events: any[] = [];
  let originalWrite: any;
  beforeEach(()=>{
    process.env.VITEST='1';
    __TEST_clearStore();
    process.env.APPROVAL_STAGE_DIAG='1';
    delete process.env.APPROVAL_FAST_PATH_DIAG; // ensure we test the async-detected path, not manual fast path
    events.length = 0;
    // Intercept stdout JSON audit lines (default backend stdout) collecting those with event field
    if(!originalWrite) originalWrite = process.stdout.write;
    process.stdout.write = function(chunk: any, encoding?: any, cb?: any){
      try {
        const text = chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
        for (const line of text.split(/\n/)) {
          if(!line.trim()) continue;
            if(line.startsWith('{')) {
              try { const obj = JSON.parse(line); if(obj.event) events.push({ name: obj.event, data: obj }); } catch {/* ignore parse */}
            }
        }
      } catch {/* ignore */}
      return originalWrite.call(process.stdout, chunk, encoding, cb);
    } as any;
  });

  afterEach(()=>{
    if(originalWrite) process.stdout.write = originalWrite;
  });

  it('finalizes approval with post_add_core_early when addApproval is async', async () => {
    const rec: any = await Store.createRequest({
      token: 't', action: 'x', payload_hash: 'h', redacted_params: {}, meta: { origin:{repo:'r'}, requester:{id:'U1',source:'slack'}, justification:'j' },
      status: 'ready_for_approval', min_approvals:1, approvals_count:0, required_personas:[], persona_state:{}, allowed_approver_ids:['U1'],
      expires_at: new Date(Date.now()+60000).toISOString(), escalate_at: undefined, escalation_channel: undefined, escalation_fired:false,
      created_at: new Date().toISOString(), policy_hash:'p', allow_param_overrides:false, override_keys: []
    });

    // Patch addApproval to return a thenable (simulate async backend without immediate mutation)
    const origAdd = (Store as any).addApproval;
    (Store as any).addApproval = (a: any) => ({
      then: (resolve: any) => setTimeout(()=> { origAdd(a); resolve(); }, 5)
    });

    const result = applyApproval(rec,'U1');
    expect(result.ok).toBe(true);
    if ('terminal' in result) {
      expect(result.terminal).toBe(true);
    } else {
      throw new Error('Expected terminal approval result');
    }
    // At this immediate moment, status should already be approved due to optimistic path
    expect(rec.status).toBe('approved');

    // Allow microtasks / timers to flush
    await new Promise(r => setTimeout(r, 15));

    // Find key events
  const names = events.map(e=>e.name);
  expect(names).toContain('approval_async_add_detected');
  expect(names).toContain('approval_async_assumed_terminal');
  // Core early post-add stage emission
  const early = events.find(e=> e.name==='approval_stage_core' && e.data?.stage==='post_add_core_early');
    expect(early).toBeTruthy();

    // Clean up patch
    (Store as any).addApproval = origAdd;
  });
});
