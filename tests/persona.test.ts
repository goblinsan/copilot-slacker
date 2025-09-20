import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import type { GuardRequestRecord } from '../src/types.js';
import { applyApproval } from '../src/approval.js';

function buildPersonas(personas: string[]): Omit<GuardRequestRecord,'id'> {
  const now = new Date().toISOString();
  return {
    token: 'tok-persona-' + personas.join('-'),
    action: 'persona_action',
    payload_hash: 'hash',
    redacted_params: {},
    meta: { origin: { repo: 'demo' }, requester: { id: 'agent', source: 'agent' }, justification: 'persona flow' },
    status: 'awaiting_personas',
    min_approvals: 1,
    approvals_count: 0,
    required_personas: personas,
    persona_state: Object.fromEntries(personas.map(p=>[p,'pending'] as const)),
    allowed_approver_ids: ['U1','U2'],
    expires_at: new Date(Date.now()+60000).toISOString(),
    created_at: now,
    policy_hash: 'p'
  };
}

let baseURL: string;
beforeAll(async () => {
  process.env.SLACK_SIGNING_SECRET = 'test_secret';
  const port = await startServer(0);
  baseURL = `http://localhost:${port}`;
});

function sign(body: string, ts: string) {
  const crypto = require('node:crypto');
  const base = `v0:${ts}:${body}`;
  const hmac = crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET || '').update(base).digest('hex');
  return `v0=${hmac}`;
}

async function ackPersona(requestId: string, persona: string, user = 'U1') {
  const payload = JSON.stringify({
    user: { id: user },
    actions: [ { action_id: `persona_ack:${persona}`, value: requestId } ]
  });
  const body = new URLSearchParams();
  body.set('payload', payload);
  const raw = body.toString();
  const ts = Math.floor(Date.now()/1000).toString();
  const sig = sign(raw, ts);
  const resp = await fetch(`${baseURL}/api/slack/interactions`,{ method:'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, body: raw });
  expect(resp.status).toBe(200);
}

describe('Persona acknowledgment flow', () => {
  it('remains awaiting until all personas ack then transitions to ready', async () => {
    const rec = await Promise.resolve(Store.createRequest(buildPersonas(['sec','ops'])));
    expect(rec.status).toBe('awaiting_personas');
    const premature = applyApproval(rec,'U1');
    expect(premature.ok).toBe(false);
    await ackPersona(rec.id,'sec');
    expect(rec.persona_state.sec).toBe('ack');
    expect(rec.status).toBe('awaiting_personas');
    await ackPersona(rec.id,'ops');
    expect(rec.persona_state.ops).toBe('ack');
    expect(rec.status).toBe('ready_for_approval');
    const appr = applyApproval(rec,'U1');
    expect(appr.ok).toBe(true);
    expect(rec.status).toBe('approved');
  });

  it('exposes persona_pending_requests gauge and persona_ack_total counter', async () => {
    const rec = await Promise.resolve(Store.createRequest(buildPersonas(['risk'])));
    // initial metrics should show pending persona
    const metrics1 = await fetch(`${baseURL}/metrics`).then(r=>r.text());
    expect(metrics1).toMatch(/persona_pending_requests{action="persona_action",persona="risk"} 1/);
    await ackPersona(rec.id,'risk');
    const metrics2 = await fetch(`${baseURL}/metrics`).then(r=>r.text());
    expect(metrics2).not.toMatch(/persona_pending_requests{action="persona_action",persona="risk"} 1/); // no longer pending
    expect(metrics2).toMatch(/persona_ack_total{action="persona_action",persona="risk"} 1/);
  });
});
