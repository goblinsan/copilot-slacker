import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, getServer } from '../src/server.js';
import { getCollectedSpans } from '../src/tracing.js';

let port: number;

async function httpJson(path: string, method='POST', body: any) {
  return await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(body)
  });
}

describe('tracing spans', () => {
  beforeAll(async () => {
    process.env.TRACING_ENABLED = 'true';
    process.env.TRACING_EXPORTER = 'memory';
    port = await startServer(0);
  });
  afterAll(() => { getServer().close(); });

  it('captures create + interaction spans', async () => {
    const resp = await httpJson('/api/guard/request','POST',{
      action:'rerequest_demo',
      params:{ x:1 },
      meta:{ origin:{repo:'demo'}, requester:{id:'U1', source:'slack'}, justification:'test' }
    });
    expect(resp.status).toBe(200);
    const js = await resp.json();
    expect(js.requestId).toBeTruthy();
    // Allow a short delay for span processor flush
    await new Promise(r=>setTimeout(r,50));
    const names = getCollectedSpans().map(s=>s.name);
    expect(names).toContain('request.create');
  });
});
