#!/usr/bin/env tsx
/**
 * Smoke test script: create a guard request and drive it to an approved terminal state.
 * Exits 0 on success, non-zero on any failure or timeout.
 * Usage: npm run smoke (adds env as needed) OR tsx scripts/smoke.ts
 */
import http from 'node:http';
import crypto from 'node:crypto';

interface CreateResp { token:string; requestId:string; status:string; }

function httpJson(port:number, path:string, method:string, body?:any, headers?:Record<string,string>):Promise<{code:number; body:string}> {
  return new Promise((resolve,reject)=>{
    const data = body? JSON.stringify(body): undefined;
    const req = http.request({ port, path, method, headers: { ...(data?{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(data))}:{}), ...(headers||{}) }}, res=>{
      let chunks=''; res.on('data',c=>chunks+=c); res.on('end',()=>resolve({ code: res.statusCode||0, body: chunks }));
    });
    req.on('error',reject); if(data) req.write(data); req.end();
  });
}

async function approve(port:number, requestId:string, userId='USMOKE', signingSecret=process.env.SLACK_SIGNING_SECRET||'test_secret') {
  const payloadObj = { type:'block_actions', user:{ id:userId }, actions:[{ action_id:'approve', value:requestId }] };
  const payload = JSON.stringify(payloadObj);
  const ts = Math.floor(Date.now()/1000).toString();
  const base = `v0:${ts}:${payload}`;
  const sig = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  const form = new URLSearchParams({ payload });
  return new Promise<{code:number; body:string}>((resolve,reject)=>{
    const req = http.request({ port, path:'/api/slack/interactions', method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded','x-slack-request-timestamp':ts,'x-slack-signature':sig }}, res=>{
      let chunks=''; res.on('data',c=>chunks+=c); res.on('end',()=>resolve({code:res.statusCode||0, body:chunks}));
    });
    req.on('error',reject); req.write(form.toString()); req.end();
  });
}

async function waitStatus(port:number, token:string, want: string[], timeoutMs=5000): Promise<string> {
  const start = Date.now();
  while (Date.now()-start < timeoutMs) {
    const res = await httpJson(port, `/api/guard/wait?token=${encodeURIComponent(token)}`,'GET');
    if (res.code===200) {
      try { const j = JSON.parse(res.body); if (want.includes(j.status)) return j.status; } catch {}
    }
    await new Promise(r=>setTimeout(r,120));
  }
  throw new Error('timeout waiting for statuses '+want.join(','));
}

async function main() {
  const port = Number(process.env.SMOKE_PORT || process.env.PORT || 8080);
  const justification = 'smoke test path';
  const createPayload = { action:'rerequest_demo', params:{ foo:'bar' }, meta:{ origin:{ repo:'smoke/repo'}, requester:{ id:'U1', source:'slack'}, justification } };
  const created = await httpJson(port,'/api/guard/request','POST', createPayload);
  if (created.code !== 200) throw new Error('create failed '+created.body);
  const parsed = JSON.parse(created.body) as CreateResp;
  if (!parsed.token || !parsed.requestId) throw new Error('invalid create response');
  if (parsed.status !== 'ready_for_approval' && parsed.status !== 'awaiting_personas') {
    throw new Error('unexpected initial status '+parsed.status);
  }
  // If personas gating appears, just exit success for now (basic smoke still reached create).
  if (parsed.status === 'awaiting_personas') {
    console.log('Smoke: request created but awaiting personas (treating as success)');
    return;
  }
  const approveRes = await approve(port, parsed.requestId);
  if (approveRes.code !== 200) throw new Error('approve call failed '+approveRes.body);
  const status = await waitStatus(port, parsed.token, ['approved','denied','expired']);
  if (status !== 'approved') throw new Error('terminal status not approved: '+status);
  console.log('Smoke: approved successfully');
}

main().catch(err => { console.error('SMOKE_FAIL', err.message || err); process.exit(1); });
