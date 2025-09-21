/**
 * Shared test helpers to reduce duplication in HTTP request creation and polling.
 * Non-goals: abstract every test concern; keep surface minimal & stable.
 */
import http from 'node:http';
import crypto from 'node:crypto';

export function httpRequest(port: number, path: string, method='GET', body?: any, headers?: Record<string,string>): Promise<{code:number, body:string}> {
  return new Promise((resolve,reject)=>{
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ port, path, method, headers: { ...(data?{ 'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(data)) }:{}), ...(headers||{}) } }, res=>{
      let chunks=''; res.on('data',c=>chunks+=c); res.on('end',()=>resolve({code:res.statusCode||0, body:chunks}));
    });
    req.on('error',reject); if(data) req.write(data); req.end();
  });
}

export async function createGuardRequest(port: number, partial?: any): Promise<{ token: string; requestId: string }> {
  const base = {
    action: 'rerequest_demo',
    params: { foo: 'bar' },
    meta: {
      origin: { repo: 'a/b' },
      requester: { id: 'U1', source: 'slack' },
      justification: 'trace test'
    }
  };
  const res = await httpRequest(port, '/api/guard/request','POST', { ...base, ...(partial||{}) });
  if(res.code!==200) throw new Error('createGuardRequest failed: '+res.body);
  const parsed = JSON.parse(res.body);
  return { token: parsed.token, requestId: parsed.requestId };
}

/**
 * Simulate a Slack block_actions approval interaction for a given request ID.
 * Generates Slack-style signature headers so security middleware still executes.
 */
export async function approveRequest(port: number, requestId: string, userId = 'UAPP', signingSecret = 'test_secret'): Promise<{ code:number; body:string }> {
  const payloadObj = { type:'block_actions', user:{ id:userId }, actions:[{ action_id:'approve', value:requestId }] };
  const payload = JSON.stringify(payloadObj);
  const ts = Math.floor(Date.now()/1000).toString();
  const base = `v0:${ts}:${payload}`;
  const sig = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  const form = new URLSearchParams({ payload });
  return new Promise((resolve,reject)=>{
    const req = http.request({ port, path:'/api/slack/interactions', method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig } }, res=>{
      let chunks=''; res.on('data',c=>chunks+=c); res.on('end',()=>resolve({ code: res.statusCode||0, body: chunks }));
    });
    req.on('error',reject); req.write(form.toString()); req.end();
  });
}

/**
 * Poll request status until it matches one of desiredStatuses (or single status string) or times out.
 */
export async function waitForStatus(port: number, token: string, desired: string|string[], opts?: { timeoutMs?: number; intervalMs?: number }): Promise<any> {
  const goals = Array.isArray(desired)? desired : [desired];
  const timeoutMs = opts?.timeoutMs ?? 4000;
  const intervalMs = opts?.intervalMs ?? 60;
  const start = Date.now();
  while(true) {
    const res = await httpRequest(port, `/api/guard/wait?token=${encodeURIComponent(token)}`);
    if(res.code===200) {
      try { const json = JSON.parse(res.body); if(goals.includes(json.status)) return json; } catch {}
    }
    if(Date.now()-start > timeoutMs) throw new Error(`waitForStatus timeout after ${timeoutMs}ms (wanted ${goals.join(',')})`);
    await new Promise(r=>setTimeout(r, intervalMs));
  }
}
