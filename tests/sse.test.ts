import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, getServer } from '../src/server.js';
import { startScheduler, stopScheduler } from '../src/scheduler.js';
import http from 'node:http';
import { createGuardRequest, approveRequest, waitForStatus } from './test-helpers.js';

let port: number;

async function createRequest(action='rerequest_demo'): Promise<{token:string,id:string}> {
  const r = await createGuardRequest(port, { action, params:{}, meta:{ origin:{repo:'x'}, requester:{id:'u', source:'agent'}, justification:'test ok'} });
  return { token: r.token, id: r.requestId } as any;
}

describe('SSE endpoint', () => {
  beforeAll(async () => { process.env.SLACK_SIGNING_SECRET='test_secret'; process.env.SSE_DEBUG='1'; port = await startServer(0); startScheduler(100); });
  afterAll(() => { getServer().close(); stopScheduler(); });

  it('streams state and reflects approval (SSE or fallback)', async () => {
    const { token, id } = await createRequest();
    const events: {event:string; data?:string}[] = [];
    let terminalViaSse = false;
    // Start SSE listener
    const ssePromise = new Promise<void>((resolve, reject) => {
      const req = http.request({ port, path:`/api/guard/wait-sse?token=${token}`, method:'GET', headers:{ Accept:'text/event-stream' } });
      req.on('response',res=>{
        let buffer='';
        res.on('data',chunk=>{
          buffer += chunk.toString();
          let idx; while((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx); buffer = buffer.slice(idx+2);
            if(!raw.trim()) continue; const lines = raw.split(/\n/);
            let ev=''; let data='';
            for (const line of lines) { if(line.startsWith('event: ')) ev=line.slice(7).trim(); else if(line.startsWith('data: ')) data=line.slice(6); }
            if(ev) { events.push({event:ev,data}); /* eslint-disable no-console */ console.log('SSE-EVENT',ev,data); }
            if(ev==='state') {
              if(data && !/approved|denied|expired/.test(data)) {
                // Trigger approval shortly after first non-terminal state
                setTimeout(async ()=>{
                  try { await approveRequest(port, id, 'U123'); } catch(e){ reject(e); }
                }, 40);
              }
              if(data && /approved|denied|expired/.test(data)) {
                terminalViaSse = /approved/.test(data);
                resolve();
              }
            }
          }
        });
      });
      req.on('error',reject); req.end();
      setTimeout(()=> reject(new Error('no terminal state received')), 6000);
    });
    // Parallel polling fallback (waitForStatus) – whichever finishes first determines assertion path
    const pollPromise = waitForStatus(port, token, ['approved','denied','expired'], { timeoutMs: 5500 }).then(st => { if(!terminalViaSse) events.push({event:'fallback', data: JSON.stringify(st)}); });
    await Promise.race([ssePromise, pollPromise]);
    // Ensure terminal actually reached (maybe via the slower of the two if race resolved early)
    const final = await waitForStatus(port, token, ['approved','denied','expired'], { timeoutMs: 6500 });
    expect(final.status).toBe('approved');
    // Require at least one non-terminal SSE state event
    expect(events.filter(e=>e.event==='state').some(e=> e.data && /ready_for_approval/.test(e.data||''))).toBe(true);
  }, 12000);
});
