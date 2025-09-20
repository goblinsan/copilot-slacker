import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, getServer } from '../src/server.js';
import { startScheduler, stopScheduler } from '../src/scheduler.js';
import { getCollectedSpans, resetCollectedSpans, initTracing, shutdownTracing } from '../src/tracing.js';
import { updateRequestMessage, postEscalationNotice } from '../src/slack.js';
import http from 'node:http';
import { Store } from '../src/store.js';
import { waitFor } from './utils/waitFor.js';

function httpRequest(path: string, method='GET', body?: any, headers?: Record<string,string>): Promise<{code:number, body:string}> {
  return new Promise((resolve,reject)=>{
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ port: serverPort, path, method, headers: { ...(data?{ 'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(data)) }:{}), ...(headers||{}) } }, res=>{
      let chunks=''; res.on('data',c=>chunks+=c); res.on('end',()=>resolve({code:res.statusCode||0, body:chunks}));
    });
    req.on('error',reject); if(data) req.write(data); req.end();
  });
}

let serverPort: number;

/**
 * This test runs with TRACING_ENABLED + memory exporter. We cannot rely on env propagation inside Vitest worker
 * so we call initTracing() manually before starting the server, with process.env configured.
 */

describe('tracing spans (#37)', () => {
  beforeAll(async () => {
    process.env.TRACING_ENABLED = 'true';
    process.env.TRACING_EXPORTER = 'memory';
    initTracing();
    serverPort = await startServer(0);
    startScheduler(50); // fast for escalate/expire
  });
  afterAll(async () => { getServer().close(); stopScheduler(); await shutdownTracing(); });

  it('emits key lifecycle spans', async () => {
    resetCollectedSpans();
    // Create request with short timeout & escalation
    const createRes = await httpRequest('/api/guard/request','POST',{
      action:'rerequest_demo',
      params:{ foo:'bar' },
      meta:{
        origin:{ repo:'a/b' },
        requester:{ id:'U1', source:'slack' },
        justification:'trace test'
      }
    });
    expect(createRes.code).toBe(200);
    const token = JSON.parse(createRes.body).token;

    // Compress timing to force escalation + expiration quickly
    const rec = await Store.getByToken(token);
    if (rec) {
      const now = Date.now();
      rec.escalate_at = new Date(now + 120).toISOString();
      rec.expires_at = new Date(now + 300).toISOString();
      rec.escalation_channel = rec.escalation_channel || 'C123TEST';
      rec.escalation_fired = false;
    }

    // Poll for required spans instead of fixed sleep to reduce flakiness
    await waitFor(() => {
      const names = getCollectedSpans().map(s=>s.name);
      return (names.includes('scheduler.escalate') && names.includes('scheduler.expire')) ? true : false;
    }, { timeoutMs: 2000, intervalMs: 50, description: 'waiting for scheduler spans' });

    const spans = getCollectedSpans().map(s=>s.name);
    // Core create span
    expect(spans).toContain('request.create');
    // Escalation + expiration spans (core scheduler instrumentation)
    expect(spans).toContain('scheduler.escalate');
    expect(spans).toContain('scheduler.expire');
    // Initial Slack post span (others may be absent without valid Slack token)
    expect(spans).toContain('slack.post_message');

    // Sanity: request should now be expired in store
    const finalRec = await waitFor(async () => {
      const r = await Store.getByToken(token);
      return r?.status === 'expired' ? r : null;
    }, { timeoutMs: 1500, intervalMs: 40, description: 'waiting for final expired status' });
    expect(finalRec!.status).toBe('expired');
  });
});
