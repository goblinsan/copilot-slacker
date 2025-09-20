import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import type { GuardRequestRecord } from '../src/types.js';
import { applyApproval } from '../src/approval.js';

function buildBase(overrides: Partial<Omit<GuardRequestRecord,'id'>> = {}): Omit<GuardRequestRecord,'id'> {
  return {
    token: 'tok-ov-'+Math.random().toString(36).slice(2),
    action: 'override_action',
    payload_hash: 'h',
    redacted_params: { packages: 'lodash', justification: 'initial' },
    meta: { origin: { repo: 'demo' }, requester: { id: 'agent', source: 'agent' }, justification: 'initial' },
    status: 'ready_for_approval',
    min_approvals: 1,
    approvals_count: 0,
    required_personas: [],
    persona_state: {},
    allowed_approver_ids: ['U1'],
    expires_at: new Date(Date.now()+60000).toISOString(),
    created_at: new Date().toISOString(),
    policy_hash: 'p',
    allow_param_overrides: true,
    override_keys: ['packages','justification'],
    ...overrides
  };
}

let baseURL: string;
beforeAll(async () => {
  process.env.SLACK_SIGNING_SECRET = 'test_secret';
  const port = await startServer(0);
  baseURL = `http://localhost:${port}`;
});

describe('Parameter overrides', () => {
  it('applies overrides and approves request via direct approval path', async () => {
  const rec = await Promise.resolve(Store.createRequest(buildBase()));
    // Simulate manual override application (bypass Slack modal network) by changing params then approving
  (rec.redacted_params as any).packages = 'lodash,axios';
  (rec.redacted_params as any).justification = 'updated';
    // Recompute hash mimic server logic
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = await import('node:crypto');
  rec.payload_hash = crypto.createHash('sha256').update(JSON.stringify(rec.redacted_params)).digest('hex');
    const res = applyApproval(rec,'U1');
    expect(res.ok).toBe(true);
    expect(rec.status).toBe('approved');
  });
});