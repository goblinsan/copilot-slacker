import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import type { GuardRequestRecord } from '../src/types.js';
import crypto from 'node:crypto';
import { validateOverrides } from '../src/override-schema.js';

function buildRecord(over: Partial<Omit<GuardRequestRecord,'id'>> = {}): Omit<GuardRequestRecord,'id'> {
  return {
    token: 'tok-schema-'+Math.random().toString(36).slice(2),
    action: 'schema_action',
    payload_hash: 'h',
    redacted_params: { packages: 'lodash', justification: 'valid reason', count: 2 },
    meta: { origin: { repo: 'demo' }, requester: { id: 'agent', source: 'agent' }, justification: 'valid reason' },
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
    override_keys: ['packages','justification','count'],
    ...over
  };
}

let baseURL: string;
beforeAll(async () => { process.env.SLACK_SIGNING_SECRET='secret'; const port = await startServer(0); baseURL = `http://localhost:${port}`; });

describe('Override schema validation', () => {
  it('accepts valid overrides (local function)', () => {
    const res = validateOverrides('schema_action', { justification: 'another good reason', packages: 'axios' });
    expect(res.ok).toBe(true);
  });
  it('rejects invalid overrides (pattern + minLength)', () => {
    const res = validateOverrides('schema_action', { packages: 'Bad*Chars', justification: 'shrt' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some(e => e.includes('packages'))).toBe(true);
      expect(res.errors.some(e => e.includes('justification'))).toBe(true);
    }
  });
  it('flows through server path and rejects invalid submission', async () => {
    const rec: GuardRequestRecord = await Promise.resolve(Store.createRequest(buildRecord())) as any;
    // Build Slack interaction payload emulating modal submission with invalid values.
  const bodyObj: any = {
      type: 'view_submission',
      user: { id: 'U1' },
      view: {
        callback_id: 'override_submit',
        private_metadata: JSON.stringify({ request_id: rec.id }),
        state: { values: {
          ov_packages: { value: { value: 'Bad*Chars' }, value2: 'unused' },
          ov_justification: { value: { value: 'shrt' } },
          ov_count: { value: { value: '3' } }
        } }
      }
    };
  const rawPayload: string = `payload=${encodeURIComponent(JSON.stringify(bodyObj))}`;
    const ts = Math.floor(Date.now()/1000).toString();
  const baseString = `v0:${ts}:${rawPayload}`;
  const sig = 'v0=' + crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET || '').update(baseString).digest('hex');
    const res = await fetch(`${baseURL}/api/slack/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig
      },
      body: rawPayload
    });
    const json = await res.json();
    expect(json.response_action).toBe('errors');
  });
  it('approves when overrides valid via server path', async () => {
    const rec: GuardRequestRecord = await Promise.resolve(Store.createRequest(buildRecord())) as any;
  const bodyObj: any = {
      type: 'view_submission',
      user: { id: 'U1' },
      view: {
        callback_id: 'override_submit',
        private_metadata: JSON.stringify({ request_id: rec.id }),
        state: { values: {
          ov_packages: { value: { value: 'axios' } },
          ov_justification: { value: { value: 'sufficiently long reason' } },
          ov_count: { value: { value: '3' } }
        } }
      }
    };
  const rawPayload: string = `payload=${encodeURIComponent(JSON.stringify(bodyObj))}`;
    const ts = Math.floor(Date.now()/1000).toString();
    const baseSig = `v0:${ts}:${rawPayload}`;
    const sig = 'v0=' + crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET || '').update(baseSig).digest('hex');
    const res = await fetch(`${baseURL}/api/slack/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig
      },
      body: rawPayload
    });
    expect(res.status).toBe(200);
    const updated = await Store.getById(rec.id);
    expect(updated?.status).toBe('approved');
  });
});
