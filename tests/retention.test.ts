import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
    vi.useFakeTimers();
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

    // Fast-forward time just before retention threshold
    vi.advanceTimersByTime(4000);
    // Approve via direct store mutation (simpler than Slack interaction): load store and set status.
    const { Store } = await import('../src/store.js');
    const rec = await Store.getByToken(token);
    expect(rec).toBeTruthy();
    if (rec) { rec.status = 'approved'; rec.decided_at = new Date(Date.now()-6000).toISOString(); }

    // Run retention sweep manually
    const { runRetentionSweep } = await import('../src/retention.js');
    await runRetentionSweep(Date.now());

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

    vi.useRealTimers();
  });
});
