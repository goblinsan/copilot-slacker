import type { CreateRequestInput } from '../types.js';

const BASE = process.env.GUARD_BASE_URL || 'http://localhost:3000';

export async function request(input: CreateRequestInput): Promise<{ token: string; requestId: string }> {
  const r = await fetch(`${BASE}/api/guard/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if(!r.ok) throw new Error(`Request failed: ${r.status}`);
  const j = await r.json();
  return { token: j.token, requestId: j.requestId };
}

export async function wait(token: string, timeoutMs = 30000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${BASE}/api/guard/wait`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const j = await r.json();
    if(['approved','denied','expired'].includes(j.status)) return j;
    await new Promise(r2 => setTimeout(r2, 2000));
  }
  return { status: 'expired' };
}
