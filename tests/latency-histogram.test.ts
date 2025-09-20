import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Verifies decision_latency_seconds histogram has action & outcome labels after approval.
 */

describe('metrics: decision latency histogram', () => {
  let base: string; let policyPath: string; let token: string; let requestId: string;
  beforeAll(async () => {
    vi.useFakeTimers();
    process.env.VITEST='1';
    policyPath = path.join(process.cwd(),'tmp_policy_latency.yml');
    fs.writeFileSync(policyPath, 'actions:\n  latency_action:\n    approvers:\n      allowSlackIds: [ULAT]\n      minApprovals: 1\n');
    process.env.POLICY_PATH = policyPath;
    const { startServer } = await import('../src/server.js');
    const port = await startServer(0); base = `http://localhost:${port}`;
  });

  it('records latency with outcome label approved', async () => {
    const createRes = await fetch(base + '/api/guard/request',{ method:'POST', body: JSON.stringify({ action:'latency_action', params:{}, meta:{ origin:{repo:'r'}, requester:{id:'ul',source:'agent'}, justification:'latency'} }) });
    const cj = await createRes.json();
    token = cj.token; requestId = cj.requestId;
    // Advance artificial clock by 2500ms
    vi.advanceTimersByTime(2500);
    // Directly mutate store to put into ready state then approve via interaction simulation
    const { Store } = await import('../src/store.js');
    const rec = await Store.getById(requestId);
    if (rec) {
      // ensure allowed approvers contains ULAT (already) and status is ready
      rec.status = 'ready_for_approval';
    }
    // Simulate approval interaction by invoking apply approval path through interactions endpoint
    const payload = { type:'block_actions', user:{ id:'ULAT' }, actions:[{ action_id:'approve', value: requestId }] };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const ts = String(Math.floor(Date.now()/1000));
    const crypto = await import('node:crypto');
    const secret = 'hist_secret';
    process.env.SLACK_SIGNING_SECRET = secret;
    const sigBase = `v0:${ts}:${body}`;
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
    const res = await fetch(base + '/api/slack/interactions',{ method:'POST', headers:{ 'x-slack-request-timestamp':ts, 'x-slack-signature':sig, 'Content-Type':'application/x-www-form-urlencoded' }, body });
    expect(res.status).toBe(200);
    // Fetch metrics and assert histogram entries
    const metrics = await fetch(base + '/metrics').then(r=>r.text());
    expect(metrics).toMatch(/decision_latency_seconds_bucket\{action="latency_action",outcome="approved",le="0.5"}/);
    expect(metrics).toMatch(/decision_latency_seconds_count\{action="latency_action",outcome="approved"} 1/);
    vi.useRealTimers();
  });
});
