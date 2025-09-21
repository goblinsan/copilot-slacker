import { __TEST_runSchedulerAt } from '../src/scheduler.js';
import { createGuardRequest, httpRequest } from './test-helpers.js';
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
    // Create request with escalation + expiration windows
  const escMs = Date.now() + 5_000;
  const expMs = Date.now() + 10_000;
  const futureEsc = new Date(escMs).toISOString();
  const futureExp = new Date(expMs).toISOString();
    const { token, requestId } = await createGuardRequest(port, {
      action: 'escalate_demo',
      escalation_channel: 'CESC',
      escalate_at: futureEsc,
      expires_at: futureExp,
  meta: { origin:{repo:'r'}, requester:{id:'U1',source:'slack'}, justification:'ok deploy'}
    });

    // Run scheduler exactly at escalation time
  await __TEST_runSchedulerAt(escMs);
    // Fetch state
    const state1 = await httpRequest(port, `/api/guard/wait?token=${token}`);
    expect(state1.code).toBe(200);
    const parsed1 = JSON.parse(state1.body);
    expect(parsed1.escalation_fired).toBe(true);
    expect(['ready_for_approval','approved']).toContain(parsed1.status);

    // Run scheduler at expiration time
  await __TEST_runSchedulerAt(expMs);
    const state2 = await httpRequest(port, `/api/guard/wait?token=${token}`);
    const parsed2 = JSON.parse(state2.body);
    // If it was approved early it should stay approved; otherwise expire
    if(parsed1.status === 'approved') {
      expect(parsed2.status).toBe('approved');
    } else {
      expect(parsed2.status).toBe('expired');
    }
  });
});
