import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
// Defer importing audit/exportAudit until after env vars configured to guarantee file backend selection.
let auditFn: any; let exportFn: any; let resetFn: any;

const FILE = 'tmp-audit-test.ndjson';

describe('Audit file backend', () => {
  beforeAll(async () => {
    process.env.AUDIT_BACKEND = 'file';
    process.env.AUDIT_FILE = FILE;
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
    const mod = await import('../src/log.js');
    resetFn = mod.__TEST_resetAudit; resetFn();
    // Re-import after reset to ensure sink picks up file backend
    const mod2 = await import('../src/log.js');
    auditFn = mod2.audit;
    exportFn = mod2.exportAudit;
    return;
  });
  it('writes and exports filtered events', async () => {
  auditFn('request_created',{ action:'demo', id:'1'});
  auditFn('request_approved',{ action:'demo', id:'1'});
  auditFn('request_created',{ action:'other', id:'2'});
    const rows: any[] = [];
  for await (const r of exportFn({ event:'request_created' })) rows.push(r);
  expect(rows.length).toBeGreaterThanOrEqual(2); // two request_created events written
  const actions = rows.map(r=>r.action).sort();
  expect(actions).toContain('demo');
  });
});
