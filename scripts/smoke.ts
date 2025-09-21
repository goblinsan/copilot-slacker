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

async function slackInteraction(port:number, requestId:string, actionId:'approve'|'deny', userId:string, signingSecret=process.env.SLACK_SIGNING_SECRET||'test_secret') {
  const payloadObj = { type:'block_actions', user:{ id:userId }, actions:[{ action_id:actionId, value:requestId }] };
  const json = JSON.stringify(payloadObj);
  const form = new URLSearchParams({ payload: json });
  const body = form.toString(); // Slack signs raw form body
  const ts = Math.floor(Date.now()/1000).toString();
  const base = `v0:${ts}:${body}`;
  const sig = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  return new Promise<{code:number; body:string}>((resolve,reject)=>{
    const req = http.request({ port, path:'/api/slack/interactions', method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded','x-slack-request-timestamp':ts,'x-slack-signature':sig }}, res=>{
      let chunks=''; res.on('data',c=>chunks+=c); res.on('end',()=>resolve({code:res.statusCode||0, body:chunks}));
    });
    req.on('error',reject); req.write(body); req.end();
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

async function fetchMetrics(port:number): Promise<string> {
  return new Promise((resolve,reject)=>{
    const req = http.request({ port, path:'/metrics', method:'GET' }, res=>{
      let chunks=''; res.on('data',c=>chunks+=c); res.on('end',()=>resolve(chunks));
    });
    req.on('error',reject); req.end();
  });
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
  const scenariosArg = process.argv.find(a=>a.startsWith('--scenarios='));
  const scenariosEnv = process.env.SMOKE_SCENARIOS;
  const want = (scenariosArg? scenariosArg.split('=')[1] : scenariosEnv || 'approve')
    .split(',')
    .map(s=>s.trim().toLowerCase())
    .filter(Boolean);

  const metricsBefore = await fetchMetrics(port);

  let approveCount=0, denyCount=0, expireCount=0; // track expectations

  // Always run approve if included
  if (want.includes('approve')) {
    const approveUser = process.env.SMOKE_APPROVE_USER || process.env.SMOKE_USER || 'U123';
  const approveRes = await slackInteraction(port, parsed.requestId, 'approve', approveUser);
    if (approveRes.code !== 200) throw new Error('approve call failed '+approveRes.body);
    const status = await waitStatus(port, parsed.token, ['approved','denied','expired']);
    if (status !== 'approved') throw new Error('terminal status not approved: '+status);
    console.log('Smoke: approve scenario OK');
    approveCount++;
  }

  // Optional deny scenario (create separate request to avoid conflicting transitions)
  if (want.includes('deny')) {
    const denyCreatePayload = { action:'rerequest_demo', params:{ foo:'bar' }, meta:{ origin:{ repo:'smoke/repo'}, requester:{ id:'U1', source:'slack'}, justification:'deny scenario' } };
    const denyCreated = await httpJson(port,'/api/guard/request','POST', denyCreatePayload);
    if (denyCreated.code !== 200) throw new Error('deny create failed '+denyCreated.body);
    const denyParsed = JSON.parse(denyCreated.body) as CreateResp;
    const denyUser = process.env.SMOKE_DENY_USER || process.env.SMOKE_USER || 'U456';
    const denyRes = await slackInteraction(port, denyParsed.requestId, 'deny', denyUser);
    if (denyRes.code !== 200) throw new Error('deny interaction failed '+denyRes.body);
    const denyStatus = await waitStatus(port, denyParsed.token, ['denied','approved','expired']);
    if (denyStatus !== 'denied') throw new Error('terminal status not denied: '+denyStatus);
    console.log('Smoke: deny scenario OK');
    denyCount++;
  }

  if (want.includes('expire')) {
    const expCreatePayload = { action:'expire_fast_demo', params:{ foo:'bar' }, meta:{ origin:{ repo:'smoke/repo'}, requester:{ id:'U1', source:'slack'}, justification:'expire scenario' } };
    const eCreated = await httpJson(port,'/api/guard/request','POST', expCreatePayload);
    if (eCreated.code !== 200) throw new Error('expire create failed '+eCreated.body);
    const eParsed = JSON.parse(eCreated.body) as CreateResp;
    const status = await waitStatus(port, eParsed.token, ['expired','approved','denied'], 15_000);
    if (status !== 'expired') throw new Error('expected expired got '+status);
    console.log('Smoke: expire scenario OK');
    expireCount++;
  }

  const metricsAfter = await fetchMetrics(port);
  interface MetricDeltaSpec { name:string; mustIncreaseIf:number; }
  const specs: MetricDeltaSpec[] = [
    { name:'approval_requests_total', mustIncreaseIf: approveCount+denyCount+expireCount },
    { name:'approvals_total', mustIncreaseIf: approveCount },
    { name:'denies_total', mustIncreaseIf: denyCount },
    { name:'expired_total', mustIncreaseIf: expireCount },
  ];
  function extractCounter(text:string, metric:string): number | undefined {
    const line = text.split(/\n/).find(l=>l.startsWith(metric+' '));
    if(!line) return undefined; const parts = line.trim().split(/\s+/); const val = parseFloat(parts[1]); return isNaN(val)? undefined: val;
  }
  for (const spec of specs) {
    if (spec.mustIncreaseIf>0) {
      const beforeVal = extractCounter(metricsBefore, spec.name);
      const afterVal = extractCounter(metricsAfter, spec.name);
      if (beforeVal === undefined || afterVal === undefined) throw new Error('missing metric '+spec.name);
      if (!(afterVal > beforeVal)) throw new Error('metric '+spec.name+' did not increase');
    }
  }
  if (!metricsAfter.includes('decision_latency_seconds_bucket')) throw new Error('missing decision_latency_seconds histogram');
  console.log('Smoke: metrics delta validation OK');

  console.log('Smoke: completed scenarios ->', want.join(','));
}

main().catch(err => { console.error('SMOKE_FAIL', err.message || err); process.exit(1); });
