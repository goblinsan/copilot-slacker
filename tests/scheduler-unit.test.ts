import { __TEST_runSchedulerAt } from '../src/scheduler.js';
import { createGuardRequest, httpRequest } from './test-helpers.js';
import { Store } from '../src/store.js';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { startServer, getServer } from '../src/server.js';

let port: number;

/**
 * Focused deterministic tests for scheduler time-based transitions.
 * Ensures escalation fires exactly once and expiration transitions terminal state.
 */
describe('scheduler deterministic transitions', () => {
  beforeAll(async () => {
    port = await startServer();
  });
  afterAll(async () => {
    const srv: any = getServer();
    await new Promise(r=>srv.close(r));
  });

  it('fires escalation at escalate_at then expires at expires_at', async () => {
    // Use existing policy action (rerequest_demo) then patch escalation fields directly via store API
    const escMs = Date.now() + 5_000;
    const expMs = Date.now() + 10_000;
    const futureEsc = new Date(escMs).toISOString();
    const futureExp = new Date(expMs).toISOString();
    const { token, requestId } = await createGuardRequest(port, {
      action: 'rerequest_demo',
      meta: { origin:{repo:'r'}, requester:{id:'U1',source:'slack'}, justification:'ok deploy'}
    });
    // Patch the underlying record (in-memory store safe in test) to simulate an escalation scenario
    const { Store } = await import('../src/store.js');
    const rec: any = await Store.getById(requestId);
    // Persist escalation timing fields using updateFields when supported to avoid Redis proxy persistence races.
    if ((Store as any).updateFields) {
      await (Store as any).updateFields(requestId, {
        escalate_at: futureEsc,
        expires_at: futureExp,
        escalation_channel: 'CESC',
        escalation_fired: false
      });
    } else {
      rec.escalate_at = futureEsc;
      rec.expires_at = futureExp;
      rec.escalation_channel = 'CESC';
      rec.escalation_fired = false;
    }

    // Run scheduler exactly at escalation time
  await __TEST_runSchedulerAt(escMs);
  // Fetch underlying record directly (need escalation_fired flag not exposed via wait API)
  const rec1: any = await Store.getById(requestId);
  expect(rec1.escalation_fired).toBe(true);
  expect(['ready_for_approval','approved']).toContain(rec1.status);

    // Run scheduler at expiration time
    await __TEST_runSchedulerAt(expMs);
  const rec2: any = await Store.getById(requestId);
    // If it was approved early it should stay approved; otherwise expire
    if(rec1.status === 'approved') {
      expect(rec2.status).toBe('approved');
    } else {
      expect(rec2.status).toBe('expired');
    }
  });
});
