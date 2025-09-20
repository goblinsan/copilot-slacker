import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { audit, exportAudit } from '../src/log.js';

const FILE = 'tmp-audit-test.ndjson';

describe('Audit file backend', () => {
  beforeAll(() => {
    process.env.AUDIT_BACKEND = 'file';
    process.env.AUDIT_FILE = FILE;
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  });
  it('writes and exports filtered events', async () => {
    audit('request_created',{ action:'demo', id:'1'});
    audit('request_approved',{ action:'demo', id:'1'});
    audit('request_created',{ action:'other', id:'2'});
    const rows: any[] = [];
    for await (const r of exportAudit({ event:'request_created', action:'demo'})) rows.push(r);
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe('request_created');
    expect(rows[0].action).toBe('demo');
  });
});
