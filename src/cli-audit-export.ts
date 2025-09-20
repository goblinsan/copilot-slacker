#!/usr/bin/env node
import { exportAudit, type AuditExportOptions } from './log.js';

async function main(){
  const args = new Map<string,string>();
  for (let i=2;i<process.argv.length;i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) { const [k,v] = a.slice(2).split('='); args.set(k,v||''); }
  }
  const opts: AuditExportOptions = {};
  if (args.get('since')) opts.since = new Date(args.get('since')!);
  if (args.get('until')) opts.until = new Date(args.get('until')!);
  if (args.get('event')) opts.event = args.get('event')!;
  if (args.get('action')) opts.action = args.get('action')!;
  if (args.get('limit')) opts.limit = Number(args.get('limit'));
  for await (const row of exportAudit(opts)) {
    process.stdout.write(JSON.stringify(row)+'\n');
  }
}
main().catch(e=>{ console.error(e); process.exit(1); });
