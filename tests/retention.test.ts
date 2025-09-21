import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// We'll dynamically import server after setting env to avoid auto-start side effects.

describe('retention sweeper', () => {
  const tmpArchive = path.join(process.cwd(),'tmp_retention_archive.jsonl');
  beforeAll(()=>{
    process.env.VITEST = '1';
    process.env.REQUEST_RETENTION_SEC = '5';
    process.env.REQUEST_RETENTION_SWEEP_SEC = '1';
    process.env.REQUEST_ARCHIVE_FILE = tmpArchive;
    if (fs.existsSync(tmpArchive)) fs.unlinkSync(tmpArchive);
  });
  afterAll(()=>{
    delete process.env.REQUEST_RETENTION_SEC;
    delete process.env.REQUEST_RETENTION_SWEEP_SEC;
    delete process.env.REQUEST_ARCHIVE_FILE;
    if (fs.existsSync(tmpArchive)) fs.unlinkSync(tmpArchive);
  });

  it('archives and purges terminal requests older than retention', async () => {
  // Create a simple policy file BEFORE importing server
  const policyPath = path.join(process.cwd(), 'tmp_policy_retention.yml');
  fs.writeFileSync(policyPath, 'actions:\n  demo:\n    approvers:\n      allowSlackIds: [U1]\n      minApprovals: 1\n');
  process.env.POLICY_PATH = policyPath;
  const { startServer } = await import('../src/server.js');
  const port = await startServer(0);
  const base = `http://localhost:${port}`;

    // Create request via HTTP
    const res = await fetch(base + '/api/guard/request',{ method:'POST', body: JSON.stringify({ action:'demo', params:{x:1}, meta:{ origin:{repo:'r'}, requester:{id:'r1', source:'agent'}, justification:'why not'}}) });
    const j = await res.json();
    expect(res.status).toBe(200);
    const token = j.token;

  // Approve via direct store mutation then flush live records for redis determinism
  const { Store } = await import('../src/store.js');
  const rec = await Store.getByToken(token);
  expect(rec).toBeTruthy();
  if (rec) {
    rec.status = 'approved';
  // Set decided_at sufficiently in the past relative to retention (retain=5s). We'll later advance clock beyond retention.
  rec.decided_at = new Date(Date.now()-6000).toISOString();
    // Persist critical fields immediately to avoid enumeration race prior to proxy microtask flush.
    if ((Store as any).updateFields) {
      try { await (Store as any).updateFields(rec.id, { status: rec.status, decided_at: rec.decided_at }); } catch {/* ignore */}
    }
  }
  if ((Store as any)._testFlushLiveRecords) { await (Store as any)._testFlushLiveRecords(); }
  // Immediate deterministic sweep invocation (may need a few attempts due to async enumeration)
  const { __TEST_forceRetentionSweep } = await import('../src/retention.js');
  let attempts = 0;
  while (attempts < 5) {
    await __TEST_forceRetentionSweep();
    if (!await Store.getByToken(token)) break;
    attempts++;
  }

    // Since decided_at is 6s in past and retention=5s, it should archive & purge.
    const recAfter = await Store.getByToken(token);
    expect(recAfter).toBeUndefined();

    // Archive file should contain one line
    expect(fs.existsSync(tmpArchive)).toBe(true);
    const lines = fs.readFileSync(tmpArchive,'utf-8').trim().split(/\n+/);
    expect(lines.length).toBe(1);
    const obj = JSON.parse(lines[0]);
    expect(obj.id).toBe(rec?.id);
    expect(obj.status).toBe('approved');

    // No fake timers
  });
});
