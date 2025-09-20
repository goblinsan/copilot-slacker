import fs from 'node:fs';
import path from 'node:path';

type AuditSink = {
  write: (row: Record<string, unknown>) => void | Promise<void>;
  export?: (opts: AuditExportOptions) => AsyncGenerator<Record<string, unknown>>;
};

interface AuditExportOptions {
  since?: Date;
  until?: Date;
  event?: string;
  action?: string; // derived from request context fields when present
  limit?: number;
}

let sink: AuditSink | undefined;

function initSink(): AuditSink {
  const backend = process.env.AUDIT_BACKEND || 'stdout';
  if (backend === 'file') {
    const file = process.env.AUDIT_FILE || 'audit.log.ndjson';
    const full = path.resolve(file);
    return {
      write(row) {
        fs.appendFileSync(full, JSON.stringify(row) + '\n');
      },
      async *export(opts: AuditExportOptions) {
        if (!fs.existsSync(full)) return;
        const data = fs.readFileSync(full, 'utf8').split(/\n/).filter(Boolean);
        let count = 0;
        for (const line of data) {
          try {
            const obj = JSON.parse(line);
            if (filterRow(obj, opts)) {
              yield obj;
              count++; if (opts.limit && count >= opts.limit) break;
            }
          } catch { /* ignore */ }
        }
      }
    };
  }
  if (backend === 'redis') {
    // Lazy import to avoid dependency if not used
    // Key: audit:events (Redis Stream) fields: ts, event, json
    try {
      // @ts-ignore dynamic
      const { createClient } = require('redis');
      const client = createClient({ url: process.env.REDIS_URL });
      client.connect().catch(()=>{});
      const streamKey = process.env.AUDIT_STREAM || 'audit:events';
      return {
        async write(row) {
          try { await client.xAdd(streamKey, '*', { ts: row.ts as string, event: row.event as string, json: JSON.stringify(row) }); } catch {/* ignore */}
        },
        async *export(opts: AuditExportOptions) {
          // Simple range scan (could be optimized with time indexing). We pull limited recent entries.
          // Fallback: XREVRANGE latest N then filter.
          const cap = opts.limit ? Math.max(opts.limit * 3, opts.limit) : 500;
          let entries: any[] = [];
          try { entries = await client.xRevRange(streamKey, '+', '-', { COUNT: cap }); } catch { entries = []; }
          let count = 0;
            for (const e of entries) {
              try {
                const obj = JSON.parse(e.message.json);
                if (filterRow(obj, opts)) { yield obj; count++; if (opts.limit && count >= opts.limit) break; }
              } catch { /* ignore */ }
            }
        }
      };
    } catch {
      // Fallback to stdout if redis unavailable
    }
  }
  // stdout default
  return {
    write(row) { process.stdout.write(JSON.stringify(row) + '\n'); }
  };
}

function filterRow(obj: any, opts: AuditExportOptions): boolean {
  if (opts.event && obj.event !== opts.event) return false;
  if (opts.action && obj.action !== opts.action && obj.request_action !== opts.action) return false;
  if (opts.since && new Date(obj.ts) < opts.since) return false;
  if (opts.until && new Date(obj.ts) > opts.until) return false;
  return true;
}

export function audit(event: string, data: Record<string, unknown>) {
  if (!sink) sink = initSink();
  const row = { ts: new Date().toISOString(), event, ...data };
  try { sink.write(row); } catch { /* swallow */ }
}

export async function *exportAudit(opts: AuditExportOptions): AsyncGenerator<Record<string, unknown>> {
  if (!sink) sink = initSink();
  if (!sink.export) return; // stdout backend has no export
  yield * sink.export(opts);
}

export type { AuditExportOptions };
