import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { startScheduler } from '../src/scheduler.js';

let baseURL: string;

beforeAll(async () => {
  const port = await startServer(0);
  baseURL = `http://localhost:${port}`;
  startScheduler(25);
});

describe('Re-request lineage', () => {
  it('creates a re-request respecting cooldown and rate limit', async () => {
    // First create an initial request via normal endpoint
    const createResp = await fetch(`${baseURL}/api/guard/request`, { method:'POST', body: JSON.stringify({ action:'rerequest_demo', params:{ foo: 'bar' }, meta: { origin: { repo: 'demo' }, requester: { id: 'agent', source: 'agent' }, justification: 'initial' } }) });
    expect(createResp.status).toBe(200);
    const base = await createResp.json();

    // Immediate re-request should fail due to cooldown (60s)
    const early = await fetch(`${baseURL}/api/guard/rerequest`, { method:'POST', body: JSON.stringify({ originalRequestId: base.requestId, actor: 'agent' }) });
    expect([429,403]).toContain(early.status); // cooldown or policy denial
    if (early.status === 429) {
      const earlyBody = await early.json();
      expect(earlyBody.error).toBe('cooldown');
    }
  });
});
