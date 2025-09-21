import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
function fetchMetrics(): Promise<string> {
  return new Promise((resolve,reject)=>{
    const req = http.request({ port, path:'/metrics', method:'GET' },res=>{ let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(d)); });
    req.on('error',reject); req.end();
  });
}
import { startServer, getServer } from '../src/server.js';
import http from 'node:http';
import { createGuardRequest } from './test-helpers.js';
import { clearReplayCache } from '../src/replay.js';
import { clearRateLimits, configureRateLimit } from '../src/ratelimit.js';

let port: number;

function sign(body: string, ts: string) {
  const crypto = require('node:crypto');
  const base = `v0:${ts}:${body}`;
  const hmac = crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET || 'test_secret').update(base).digest('hex');
  return `v0=${hmac}`;
}

function interaction(payloadObj: any, override?: { ts?: string; sig?: string }) {
  return new Promise<{code:number, body:string}>((resolve,reject)=>{
    const rawPayload = new URLSearchParams({ payload: JSON.stringify(payloadObj) }).toString();
    const ts = override?.ts || Math.floor(Date.now()/1000).toString();
    const sig = override?.sig || sign(rawPayload, ts);
    const req = http.request({ port, path:'/api/slack/interactions', method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','x-slack-request-timestamp':ts,'x-slack-signature':sig}},res=>{
      let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve({code:res.statusCode||0, body:d}));
    });
    req.on('error',reject); req.write(rawPayload); req.end();
  });
}

async function createRequest(): Promise<{token:string,id:string}> {
  const r = await createGuardRequest(port, { action:'rerequest_demo', params:{}, meta:{ origin:{repo:'x'}, requester:{id:'u', source:'agent'}, justification:'sec test'} });
  return { token: r.token, id: r.requestId } as any;
}

describe('security hardening', () => {
  beforeAll(async () => { process.env.SLACK_SIGNING_SECRET='test_secret'; port = await startServer(0); });
  afterAll(() => { getServer().close(); });
  afterEach(() => { clearReplayCache(); clearRateLimits(); });

  it('rejects stale timestamp (>300s skew)', async () => {
    const staleTs = (Math.floor(Date.now()/1000) - 400).toString();
    const res = await interaction({ user:{id:'U123'}, actions:[{ action_id:'approve', value:'id' }] }, { ts: staleTs });
    expect(res.code).toBe(400);
    expect(res.body).toContain('stale_signature');
    const m = await fetchMetrics();
    expect(m).toMatch(/security_events_total{type="stale_signature"} 1/);
  });

  it('rejects replayed signature', async () => {
    const ts = Math.floor(Date.now()/1000).toString();
    const payloadObj = { user:{id:'U123'}, actions:[{ action_id:'approve', value:'id' }] };
    const rawPayload = new URLSearchParams({ payload: JSON.stringify(payloadObj) }).toString();
    const sig = sign(rawPayload, ts);
    const first = await interaction(payloadObj, { ts, sig });
    expect(first.code).toBe(200); // initial accepted (no replay)
    const second = await interaction(payloadObj, { ts, sig });
    expect(second.code).toBe(400);
    expect(second.body).toContain('replay_detected');
    const m = await fetchMetrics();
    expect(m).toMatch(/security_events_total{type="replay"} 1/);
  });

  it('applies rate limit on request creation', async () => {
    configureRateLimit(2, 0); // capacity 2, no refill
    const a = await createRequest(); expect(a.id).toBeTruthy();
    const b = await createRequest(); expect(b.id).toBeTruthy();
    const c = await new Promise<{code:number, body:string}>((resolve,reject)=>{
      const payload = JSON.stringify({ action:'rerequest_demo', params:{}, meta:{ origin:{repo:'x'}, requester:{id:'u', source:'agent'}, justification:'sec test'} });
      const req = http.request({ port, path:'/api/guard/request', method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{ let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve({code:res.statusCode||0, body:d})); });
      req.on('error',reject); req.write(payload); req.end();
    });
    expect(c.code).toBe(429);
    expect(c.body).toContain('rate_limited');
    const m = await fetchMetrics();
    expect(m).toMatch(/security_events_total{type="rate_limited"} 1/);
  });
});
