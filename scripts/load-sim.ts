#!/usr/bin/env node
/**
 * Simple load simulation script (Item #13).
 * Generates a number of approval requests concurrently and (optionally) auto-approves them.
 * Outputs latency percentiles (P50/P90/P95/P99) for creation and decision phases.
 *
 * Usage:
 *  npx tsx scripts/load-sim.ts --requests 200 --concurrency 25 --approve true
 *  env vars: POLICY_PATH (optional custom policy); others from service.
 */
import fs from 'node:fs';
import path from 'node:path';

interface Args { requests: number; concurrency: number; approve: boolean; action: string; }
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const map: Record<string,string> = {};
  for (let i=0;i<a.length;i+=2) { const k=a[i]; const v=a[i+1]; if(k && k.startsWith('--')) map[k.slice(2)] = v; }
  return {
    requests: Number(map.requests||'100'),
    concurrency: Number(map.concurrency||'10'),
    approve: (map.approve||'true') === 'true',
    action: map.action || 'load_action'
  };
}

function percentile(sorted: number[], p: number) { if(!sorted.length) return 0; const idx = Math.ceil(p/100 * sorted.length)-1; return sorted[Math.min(Math.max(idx,0),sorted.length-1)]; }

async function main(){
  if (!process.env.POLICY_PATH) {
    const tmpPolicy = path.join(process.cwd(),'tmp_policy_load.yml');
    if (!fs.existsSync(tmpPolicy)) {
      fs.writeFileSync(tmpPolicy, 'actions:\n  load_action:\n    approvers:\n      allowSlackIds: [ULOAD]\n      minApprovals: 1\n');
    }
    process.env.POLICY_PATH = tmpPolicy;
  }
  process.env.VITEST = '1'; // prevent auto-start side effects if any
  // Directly import TypeScript sources; rely on tsx runtime when executed.
  let { startServer } = await import('../src/server.ts');
  const port = await startServer(0);
  const base = `http://localhost:${port}`;
  const { requests, concurrency, approve, action } = parseArgs();

  const createLat: number[] = []; // latency for request creation HTTP call
  const approvalOpLat: number[] = []; // latency for local approval operation (applyApproval)
  const endToEndLat: number[] = []; // creation -> terminal decision (only when approvals applied synchronously)
  const errors: string[] = [];

  interface RecRef { token: string; requestId: string; createdAt: number; }
  const queue: RecRef[] = [];

  async function workerCreate(startIndex: number, count: number) {
    for (let i=0;i<count;i++) {
      const idx = startIndex + i;
      const t0 = performance.now();
      try {
        const res = await fetch(base + '/api/guard/request',{ method:'POST', body: JSON.stringify({ action, params:{ n: idx }, meta:{ origin:{repo:'r'}, requester:{id:'u',source:'agent'}, justification:'load test'} }) });
        if (res.status !== 200) { errors.push('create:'+res.status); continue; }
        const j = await res.json();
        const t1 = performance.now();
        createLat.push(t1 - t0);
  queue.push({ token: j.token, requestId: j.requestId, createdAt: Date.now() });
      } catch (e:any) { errors.push('create_err:'+e.message); }
    }
  }

  // Launch creators with fixed chunk division
  const per = Math.ceil(requests / concurrency);
  const creators: Promise<void>[] = [];
  for (let w=0; w<concurrency; w++) creators.push(workerCreate(w*per, Math.min(per, requests - w*per)));
  await Promise.all(creators);

  if (approve) {
    const { Store } = await import('../src/store.ts');
    const { applyApproval } = await import('../src/approval.ts');
    for (const r of queue) {
      const rec = await Store.getById(r.requestId) as any;
      if (!rec) continue;
      // Ensure status ready (skip personas flow for load simplicity)
      if (rec.status !== 'ready_for_approval') rec.status = 'ready_for_approval';
      const t0 = performance.now();
      applyApproval(rec, 'ULOAD');
      const t1 = performance.now();
      if (rec.decided_at) {
        approvalOpLat.push(t1 - t0);
        endToEndLat.push(performance.now() - r.createdAt);
      }
    }
  }

  createLat.sort((a,b)=>a-b); approvalOpLat.sort((a,b)=>a-b); endToEndLat.sort((a,b)=>a-b);
  function summary(name: string, arr: number[]) {
    if(!arr.length) return { name, count:0 } as any;
    return { name, count: arr.length, p50: percentile(arr,50), p90: percentile(arr,90), p95: percentile(arr,95), p99: percentile(arr,99), max: arr[arr.length-1] };
  }
  const result = { action, requests, concurrency, approve, summaries: [summary('create_ms', createLat), summary('approval_operation_ms', approvalOpLat), summary('end_to_end_ms', endToEndLat)], errors };
  // Human readable
  console.log('--- Load Simulation Summary ---');
  for (const s of result.summaries) {
    if (!s.count) { console.log(`${s.name}: (none)`); continue; }
    console.log(`${s.name}: count=${s.count} p50=${s.p50.toFixed(2)} p90=${s.p90.toFixed(2)} p95=${s.p95.toFixed(2)} p99=${s.p99.toFixed(2)} max=${s.max.toFixed(2)}`);
  }
  if (errors.length) console.log('Errors:', errors.slice(0,10));
  console.log(JSON.stringify(result, null, 2));
}

main().catch(e => { console.error('load-sim failed', e); process.exit(1); });
