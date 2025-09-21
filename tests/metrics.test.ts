import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, getServer } from '../src/server.js';
import { resetAllMetrics } from '../src/metrics.js';
import { Store } from '../src/store.js';
import http from 'node:http';
import { createGuardRequest } from './test-helpers.js';
import { startScheduler, stopScheduler } from '../src/scheduler.js';

function httpRequest(path: string, method='GET', body?: any): Promise<{code:number, body:string}> {
  return new Promise((resolve,reject)=>{
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ port: serverPort, path, method, headers: data?{ 'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:undefined }, res=>{
      let chunks=''; res.on('data',c=>chunks+=c); res.on('end',()=>resolve({code:res.statusCode||0, body:chunks}));
    });
    req.on('error',reject); if(data) req.write(data); req.end();
  });
}

let serverPort: number;

describe('metrics exposure', () => {
  beforeAll(async () => {
    resetAllMetrics();
    serverPort = await startServer(0);
    startScheduler(100); // fast
  });
  afterAll(() => { getServer().close(); stopScheduler(); });

  it('captures request creation and approval metrics', async () => {
    const created = await createGuardRequest(serverPort, { action:'rerequest_demo', params:{foo:'bar'}, meta:{ origin:{ repo:'x/y' }, requester:{ id:'U1', source:'slack' }, justification:'test justification' } });
    const token = created.token;
    // approve path not directly invoking /metrics update; just create then fetch metrics
    const metrics = await httpRequest('/metrics');
    expect(metrics.code).toBe(200);
  expect(metrics.body).toMatch(/approval_requests_total{action="rerequest_demo"} 1/);
  expect(metrics.body).toMatch(/pending_requests{action="rerequest_demo"} 1/);
    // Force expire by manipulating store (if listOpenRequests present) - set expires_at in past
    const record = await Store.getByToken(token);
    if(record){
      record.expires_at = new Date(Date.now()-1000).toISOString();
    }
    // wait for scheduler cycle
    await new Promise(r=>setTimeout(r,350));
    const metrics2 = await httpRequest('/metrics');
    expect(metrics2.body).toMatch(/expired_total{action="rerequest_demo"} 1/);
    // New histogram now labeled by action and outcome; ensure at least one bucket line present for expired outcome
    expect(metrics2.body).toMatch(/decision_latency_seconds_bucket{action="rerequest_demo",outcome="expired",le="/);
  });
});
