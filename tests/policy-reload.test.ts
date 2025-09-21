import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { reloadPolicy, getPolicy } from '../src/policy.js';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createGuardRequest } from './test-helpers.js';
import yaml from 'yaml';

function httpReq(opts: { path: string; method?: string; body?: any; headers?: Record<string,string> }, port: number): Promise<{code:number, body:string}> {
  return new Promise((resolve,reject)=>{
    const data = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = http.request({ port, path: opts.path, method: opts.method||'GET', headers: { 'Content-Type':'application/json', ...(data?{ 'Content-Length': String(Buffer.byteLength(data)) }:{}), ...(opts.headers||{}) } }, res=>{
      let chunks=''; res.on('data',c=>chunks+=c); res.on('end',()=>resolve({code:res.statusCode||0, body:chunks}));
    });
    req.on('error',reject); if (data) req.write(data); req.end();
  });
}

describe('policy hot reload (#40)', () => {
  let port: number; 
  const originalPath = process.env.POLICY_PATH || '.agent/policies/guards.yml';
  const originalContent = fs.readFileSync(originalPath,'utf8');
  const tmpPath = path.join(process.cwd(), 'tmp-policy-reload.yml');
  const tmpAction = 'reload_demo_action';
  let serverMod: any;
  beforeAll(async () => {
    // Prepare temp policy before loading server module so it picks up env
    fs.writeFileSync(tmpPath, originalContent, 'utf8');
    process.env.POLICY_PATH = tmpPath;
    process.env.ADMIN_TOKEN = 'admintest';
    serverMod = await import('../src/server.js');
    port = await serverMod.startServer(0);
  });
  afterAll(() => {
    // Cleanup: close server first, then remove temp file. We do not reload original since server stops.
    serverMod.getServer().close();
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    process.env.POLICY_PATH = originalPath;
  });
  it('exposes new action only after reload', async () => {
  const before = getPolicy();
    expect(before?.actions[tmpAction]).toBeUndefined();
    // Modify temp policy file properly via YAML
    const parsed = yaml.parse(fs.readFileSync(tmpPath,'utf8'));
    parsed.actions = parsed.actions || {};
  parsed.actions[tmpAction] = { approvers: { allowSlackIds: ['UADMIN1'], minApprovals: 1 } };
    fs.writeFileSync(tmpPath, yaml.stringify(parsed), 'utf8');
    // Attempt request before reload => 403
  const pre = await httpReq({ path:'/api/guard/request', method:'POST', body:{ action: tmpAction, params:{ a:1 }, meta:{ origin:{ repo:'x' }, requester:{ id:'UADMIN1', source:'slack' }, justification:'test'} } }, port);
    expect(pre.code).toBe(403);
    // Reload without token unauthorized
    const unauth = await httpReq({ path:'/api/admin/reload-policy', method:'POST' }, port);
    expect(unauth.code).toBe(401);
    // Reload with token
    const ok = await httpReq({ path:'/api/admin/reload-policy', method:'POST', headers:{ 'x-admin-token':'admintest' } }, port);
    expect(ok.code).toBe(200);
    // Now request should succeed
  const post = await httpReq({ path:'/api/guard/request', method:'POST', body:{ action: tmpAction, params:{ a:1 }, meta:{ origin:{ repo:'x' }, requester:{ id:'UADMIN1', source:'slack' }, justification:'test'} } }, port);
    expect(post.code).toBe(200);
  });
});
