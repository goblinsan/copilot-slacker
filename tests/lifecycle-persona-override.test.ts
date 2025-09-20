import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function sign(secret: string, ts: string, body: string){
  const sigBase = `v0:${ts}:${body}`;
  const hmac = crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
  return `v0=${hmac}`;
}

describe('full lifecycle: personas + overrides + approval', () => {
  const secret = 'sec_override';
  let base: string; let policyPath: string; let requestId: string; let token: string;
  beforeAll(async () => {
    process.env.VITEST='1';
    process.env.SLACK_SIGNING_SECRET = secret;
    policyPath = path.join(process.cwd(),'tmp_policy_lifecycle.yml');
    // Policy: action test_action requires persona alpha,beta; minApprovals=1; overrides allowed for key x
    fs.writeFileSync(policyPath, 'actions:\n  test_action:\n    approvers:\n      allowSlackIds: [UAPP]\n      minApprovals: 1\n    personasRequired: [alpha, beta]\n    allowParamOverrides: true\n    overrideKeys: [x]\n');
    process.env.POLICY_PATH = policyPath;
    const { startServer } = await import('../src/server.js');
    const port = await startServer(0); base = `http://localhost:${port}`;
  });

  it('creates request awaiting personas', async () => {
    const res = await fetch(base + '/api/guard/request', { method:'POST', body: JSON.stringify({ action:'test_action', params:{ x:1 }, meta:{ origin:{repo:'r'}, requester:{id:'rq',source:'agent'}, justification:'do it'} }) });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.status).toBe('awaiting_personas');
    token = j.token; requestId = j.requestId;
  });

  it('acks personas and transitions to ready_for_approval', async () => {
    for (const persona of ['alpha','beta']) {
      const payload = { type:'block_actions', user:{ id:'UAPP' }, actions:[{ action_id:`persona_ack:${persona}`, value: requestId }] };
      const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
      const ts = String(Math.floor(Date.now()/1000));
      const sig = sign(secret, ts, body);
      const res = await fetch(base + '/api/slack/interactions',{ method:'POST', headers:{ 'x-slack-request-timestamp':ts, 'x-slack-signature':sig, 'Content-Type':'application/x-www-form-urlencoded' }, body });
      expect(res.status).toBe(200);
    }
    // Query state via token wait endpoint to ensure status changed
    const wait = await fetch(base + `/api/guard/wait?token=${token}`);
    const wj = await wait.json();
    expect(['ready_for_approval','approved']).toContain(wj.status); // could already move later
  });

  it('submits override + approve via modal view submission', async () => {
    // Craft modal submission payload (simulate overrides modal with changed x)
    const viewSubmission = { type:'view_submission', view:{ callback_id:'override_submit', private_metadata: JSON.stringify({ request_id: requestId }), state:{ values:{ [`ov_x`]:{ value:{ value:'42' } } } } }, user:{ id:'UAPP' } };
    const body = `payload=${encodeURIComponent(JSON.stringify(viewSubmission))}`;
    const ts = String(Math.floor(Date.now()/1000));
    const sig = sign(secret, ts, body);
    const res = await fetch(base + '/api/slack/interactions',{ method:'POST', headers:{ 'x-slack-request-timestamp':ts, 'x-slack-signature':sig, 'Content-Type':'application/x-www-form-urlencoded' }, body });
    expect(res.status).toBe(200);
    // Wait for terminal state
    const wait = await fetch(base + `/api/guard/wait?token=${token}`);
    const wj = await wait.json();
    expect(wj.status).toBe('approved');
  });

  it('exposes updated metrics including approvals and override counters', async () => {
    const res = await fetch(base + '/metrics');
    const text = await res.text();
    expect(text).toMatch(/approvals_total{action="test_action"} 1/);
    expect(text).toMatch(/param_overrides_total{action="test_action",outcome="applied"} 1/);
  });
});
