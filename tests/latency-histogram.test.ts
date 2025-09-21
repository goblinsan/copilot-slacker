import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Verifies decision_latency_seconds histogram has action & outcome labels after approval.
 */

describe('metrics: decision latency histogram', () => {
  let base: string; let policyPath: string; let requestId: string;
  beforeAll(async () => {
    process.env.VITEST='1';
    policyPath = path.join(process.cwd(),'tmp_policy_latency.yml');
    fs.writeFileSync(policyPath, 'actions:\n  latency_action:\n    approvers:\n      allowSlackIds: [ULAT]\n      minApprovals: 1\n');
    process.env.POLICY_PATH = policyPath;
    const { startServer } = await import('../src/server.js');
    const port = await startServer(0); base = `http://localhost:${port}`;
  });

  it('records latency with outcome label approved', async () => {
    // Create request
    const createRes = await fetch(base + '/api/guard/request',{ method:'POST', body: JSON.stringify({ action:'latency_action', params:{}, meta:{ origin:{repo:'r'}, requester:{id:'ul',source:'agent'}, justification:'latency'} }) });
    const cj = await createRes.json();
    requestId = cj.requestId;
    // Directly approve via applyApproval for determinism
    const { Store } = await import('../src/store.js');
    const { applyApproval } = await import('../src/approval.js');
    const rec = await Store.getById(requestId);
    expect(rec).toBeTruthy();
    if (rec) {
      rec.status = 'ready_for_approval';
      if ((Store as any).updateFields) { try { await (Store as any).updateFields(rec.id, { status: rec.status }); } catch {/* ignore */} }
      const result = applyApproval(rec, 'ULAT');
      expect(result.ok).toBe(true);
      // If still non-terminal (unlikely), force finalize for test
  if ((rec.status as any) !== 'approved' && rec.approvals_count >= rec.min_approvals) {
        rec.status = 'approved';
        (rec as any).decided_at = new Date().toISOString();
        if ((Store as any).updateFields) { try { await (Store as any).updateFields(rec.id, { status: rec.status, decided_at: (rec as any).decided_at, approvals_count: rec.approvals_count }); } catch {/* ignore */} }
      }
    }
    // Flush any proxy buffered changes
    if ((Store as any)._testFlushLiveRecords) { await (Store as any)._testFlushLiveRecords(); }
    // Retrieve metrics
    const metrics = await fetch(base + '/metrics').then(r=>r.text());
    expect(metrics).toMatch(/decision_latency_seconds_bucket\{action="latency_action",outcome="approved",le="0.5"}/);
    expect(metrics).toMatch(/decision_latency_seconds_count\{action="latency_action",outcome="approved"} 1/);
  });
});
