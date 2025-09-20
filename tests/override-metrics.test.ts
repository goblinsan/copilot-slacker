import { describe, it, expect } from 'vitest';
import { startServer } from '../src/server.js';
import crypto from 'node:crypto';
import { Store } from '../src/store.js';
import type { GuardRequestRecord } from '../src/types.js';

async function createManualRequest(action: string): Promise<string> {
  const now = Date.now();
  const rec = await Store.createRequest({
    token: crypto.randomUUID(),
    action,
    payload_hash: crypto.createHash('sha256').update('{}').digest('hex'),
    redacted_params: {},
    meta: { origin: { repo: 'demo' }, requester: { id: 'agent', source: 'agent' }, justification: 'metrics test' },
    status: 'ready_for_approval',
    min_approvals: 1,
    approvals_count: 0,
    required_personas: [],
    persona_state: {},
    allowed_approver_ids: ['UADMIN1'],
    expires_at: new Date(now + 60000).toISOString(),
    created_at: new Date().toISOString(),
    policy_hash: 'p',
    allow_param_overrides: true,
    override_keys: ['reason','count']
  } as Omit<GuardRequestRecord,'id'>);
  return rec.id;
}

describe('Override metrics', () => {
  it('exposes override metrics with outcome and rejection reasons', async () => {
    const port = await startServer(0);
    const base = `http://localhost:${port}`;
    // Ensure schema present for rejection (reason minLength=5)
  const requestIdRejected = await createManualRequest('introspect_demo');
  const requestIdApplied = await createManualRequest('introspect_demo');
    // Simulate rejected override via schema fail (reason too short)
    function slackSig(body: string){
      const secret = process.env.SLACK_SIGNING_SECRET || '';
      const ts = String(Math.floor(Date.now()/1000));
      const baseStr = `v0:${ts}:${body}`;
      const hmac = crypto.createHmac('sha256', secret).update(baseStr).digest('hex');
      return { ts, sig: `v0=${hmac}` };
    }
    // We need the request records to derive approver (use superApprover UADMIN1)
    const userId = 'UADMIN1';
    const payloadRejected = new URLSearchParams({
      payload: JSON.stringify({
        type: 'view_submission',
        user: { id: userId },
        view: {
          callback_id: 'override_submit',
          private_metadata: JSON.stringify({ request_id: requestIdRejected }),
          state: { values: { ov_reason: { value: { value: 'bad' } } } }
        }
      })
    }).toString();
    const sigR = slackSig(payloadRejected);
    await fetch(`${base}/api/slack/interactions`, { method:'POST', headers: { 'Content-Type':'application/x-www-form-urlencoded', 'x-slack-request-timestamp': sigR.ts, 'x-slack-signature': sigR.sig }, body: payloadRejected });

    // Simulate applied override (reason valid length)
    const payloadApplied = new URLSearchParams({
      payload: JSON.stringify({
        type: 'view_submission',
        user: { id: userId },
        view: {
          callback_id: 'override_submit',
          private_metadata: JSON.stringify({ request_id: requestIdApplied }),
          state: { values: { ov_reason: { value: { value: 'valid reason' } } } }
        }
      })
    }).toString();
    const sigA = slackSig(payloadApplied);
    await fetch(`${base}/api/slack/interactions`, { method:'POST', headers: { 'Content-Type':'application/x-www-form-urlencoded', 'x-slack-request-timestamp': sigA.ts, 'x-slack-signature': sigA.sig }, body: payloadApplied });

  // small delay to ensure handlers finished
  await new Promise(r=>setTimeout(r,50));
  const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(/override_rejections_total{.*action="introspect_demo".*reason="schema_validation"} 1/);
    expect(metrics).toMatch(/param_overrides_total{.*action="introspect_demo".*outcome="rejected"} 1/);
    expect(metrics).toMatch(/param_overrides_total{.*action="introspect_demo".*outcome="applied"} 1/);
  });
});
