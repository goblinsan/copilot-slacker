import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, getServer } from '../src/server.js';
import { startScheduler, stopScheduler } from '../src/scheduler.js';
import http from 'node:http';
import { createGuardRequest, approveRequest } from './test-helpers.js';

let port: number;

async function createRequest(action='rerequest_demo'): Promise<{token:string,id:string}> {
  const r = await createGuardRequest(port, { action, params:{}, meta:{ origin:{repo:'x'}, requester:{id:'u', source:'agent'}, justification:'test ok'} });
  return { token: r.token, id: r.requestId } as any;
}

describe('SSE endpoint', () => {
  beforeAll(async () => { process.env.SLACK_SIGNING_SECRET='test_secret'; port = await startServer(0); startScheduler(100); });
  afterAll(() => { getServer().close(); stopScheduler(); });

  it('streams state and closes after approval', async () => {
    const { token, id } = await createRequest();
    // Connect SSE
    const events: {event:string; data?:string}[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ port, path:`/api/guard/wait-sse?token=${token}`, method:'GET', headers:{ Accept:'text/event-stream' } });
      req.on('response',res=>{
        let closed = false;
        let buffer = '';
        res.on('data',chunk=>{
          buffer += chunk.toString();
          let idx;
          while((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx+2);
            if(!raw.trim()) continue;
            const lines = raw.split(/\n/);
            let ev=''; let data='';
            for (const line of lines) {
              if(line.startsWith('event: ')) ev = line.slice(7).trim();
              else if(line.startsWith('data: ')) data = line.slice(6);
            }
            if(ev){ events.push({event:ev, data}); }
            if(ev==='state' && data && /approved|denied|expired/.test(data)) {
              setTimeout(()=>{ if(!closed){ closed=true; res.destroy(); resolve(); } },25);
            }
          }
        });
        res.on('end',()=>{ if(!closed){ closed=true; resolve(); }});
      });
      req.on('error',reject); req.end();
  // Approve only after first state event observed
  const approveAfterFirst = () => { approveRequest(port, id, 'U456').catch(reject); };
  const origPush = events.push.bind(events);
  (events as any).push = (val: any) => { const r = origPush(val); if(val.event==='state' && (!/approved|denied|expired/.test(val.data||''))) { setTimeout(approveAfterFirst,100); } return r; };
      // Fallback timeout in case no terminal
      setTimeout(()=>{ reject(new Error('no terminal state received')); }, 4000);
    });
    // Validate at least one state event before approval and one terminal event
    const stateEvents = events.filter(e=>e.event==='state');
  expect(stateEvents.length).toBeGreaterThanOrEqual(1);
  const anyTerminal = stateEvents.some(ev => ev.data && /approved|denied|expired/.test(ev.data));
  expect(anyTerminal).toBe(true);
  }, 8000);
});
