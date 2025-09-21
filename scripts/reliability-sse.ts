#!/usr/bin/env tsx
/**
 * SSE / workflow reliability loop.
 * Re-runs the existing smoke script multiple times (default 5) focusing on
 * scenarios that exercise approval + fast expiration (which triggers escalation)
 * to surface any intermittent SSE or state transition issues.
 *
 * Usage:
 *   npm run reliability:sse            # 5 iterations approve,expire
 *   ITERATIONS=10 npm run reliability:sse
 *   SMOKE_SCENARIOS=approve,expire ITERATIONS=8 npm run reliability:sse
 *
 * Exits non‑zero on the first failed iteration; prints summary stats on success.
 */
import { spawn } from 'node:child_process';

interface IterResult { iter:number; ok:boolean; durationMs:number; error?:string }

function runSmoke(iter:number, scenarios:string, port:number): Promise<IterResult> {
  const start = Date.now();
  return new Promise(resolve => {
    const env = { ...process.env, SMOKE_SCENARIOS: scenarios, SMOKE_PORT: String(port) };
    const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs','scripts/smoke.ts'], { env, stdio:['ignore','pipe','pipe'] });
    let stderr='';
    child.stdout.on('data', d => process.stdout.write(`[iter ${iter}] ${d}`));
    child.stderr.on('data', d => { stderr += d; process.stderr.write(`[iter ${iter} ERR] ${d}`); });
    child.on('close', code => {
      const durationMs = Date.now()-start;
      if (code === 0) return resolve({ iter, ok:true, durationMs });
      resolve({ iter, ok:false, durationMs, error: stderr.trim() || `exit ${code}` });
    });
  });
}

async function main() {
  const iterations = Number(process.env.ITERATIONS || 5);
  if (!Number.isFinite(iterations) || iterations < 1) throw new Error('invalid ITERATIONS');
  const port = Number(process.env.SMOKE_PORT || process.env.PORT || 8080);
  const scenarios = process.env.SMOKE_SCENARIOS || 'approve,expire';
  console.log(`Reliability: starting ${iterations} iterations with scenarios=${scenarios} against port ${port}`);
  const results: IterResult[] = [];
  for (let i=1;i<=iterations;i++) {
    console.log(`\n=== Iteration ${i}/${iterations} ===`);
    const r = await runSmoke(i, scenarios, port);
    results.push(r);
    if (!r.ok) {
      console.error(`Reliability: iteration ${i} failed after ${r.durationMs}ms: ${r.error}`);
      break;
    }
  }
  const failures = results.filter(r=>!r.ok);
  if (failures.length) {
    console.error(`Reliability: FAILED after ${results.length} iterations (${failures.length} failures).`);
    process.exit(1);
  }
  const totalMs = results.reduce((a,b)=>a+b.durationMs,0);
  const avgMs = Math.round(totalMs / results.length);
  console.log(`\nReliability: success. ${results.length} iterations, avg duration ${avgMs}ms.`);
}

main().catch(err => { console.error('Reliability: unexpected error', err); process.exit(1); });
