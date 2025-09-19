export function audit(event: string, data: Record<string, unknown>) {
  // TODO: Persist to durable storage; for now stdout JSON
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n');
}
