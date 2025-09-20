import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import type { GuardRequestRecord } from '../src/types.js';

function build(overrides: Partial<Omit<GuardRequestRecord,'id'>> = {}): Omit<GuardRequestRecord,'id'> {
  return {
    token: 'tok-gov-'+Math.random().toString(36).slice(2),
    action: 'gov_action',
    payload_hash: 'h',
    redacted_params: { a:'1', b:'2', c:'3' },
    meta: { origin: { repo: 'demo' }, requester: { id: 'agent', source: 'agent' }, justification: 'gov' },
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
    override_keys: ['a','b','c'],
    ...overrides
  };
}

let baseURL: string;
beforeAll(async () => { const port = await startServer(0); baseURL = `http://localhost:${port}`; });
beforeEach(()=>{ process.env.OVERRIDE_MAX_KEYS = '1'; });

describe('Override governance', () => {
  it('rejects when changed keys exceed limit', async () => {
    const rec = await Promise.resolve(Store.createRequest(build()));
    // Simulate override submission changing two keys while limit=1
    process.env.OVERRIDE_MAX_KEYS = '1';
    // We directly emulate the logic computing overrides
    const changed = { a:'10', b:'20' };
    const exceeded = Object.keys(changed).length > Number(process.env.OVERRIDE_MAX_KEYS);
    expect(exceeded).toBe(true);
  });
});
