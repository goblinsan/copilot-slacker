import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';

// Helper to build Slack-style signature
function sign(secret: string, ts: string, body: string){
  const sigBase = `v0:${ts}:${body}`;
  const hmac = crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
  return `v0=${hmac}`;
}

describe('security: replay & timestamp skew', () => {
  const secret = 'test_signing_secret';
  let base: string;
  beforeAll(async () => {
    process.env.VITEST = '1';
    process.env.SLACK_SIGNING_SECRET = secret;
    const { startServer } = await import('../src/server.js');
    const port = await startServer(0);
    base = `http://localhost:${port}`;
  });

  it('rejects stale timestamp (>300s)', async () => {
    const ts = String(Math.floor(Date.now()/1000) - 400); // 400s in past
    const payload = { type:'block_actions', actions:[{ action_id:'approve', value:'noop' }] };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const sig = sign(secret, ts, body);
    const res = await fetch(base + '/api/slack/interactions', {
      method:'POST',
      headers:{ 'x-slack-request-timestamp': ts, 'x-slack-signature': sig, 'Content-Type':'application/x-www-form-urlencoded' },
      body
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toMatch(/stale_signature/);
  });

  it('detects replay of identical signature/timestamp', async () => {
    const ts = String(Math.floor(Date.now()/1000));
    const payload = { type:'block_actions', actions:[{ action_id:'approve', value:'noop' }] };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const sig = sign(secret, ts, body);
    // First request should succeed signature + skew validation and not be treated as replay
    const first = await fetch(base + '/api/slack/interactions', {
      method:'POST', headers:{ 'x-slack-request-timestamp': ts, 'x-slack-signature': sig, 'Content-Type':'application/x-www-form-urlencoded' }, body });
    expect(first.status).toBe(200);
    // Second identical request -> replay detection should trip
    const second = await fetch(base + '/api/slack/interactions', {
      method:'POST', headers:{ 'x-slack-request-timestamp': ts, 'x-slack-signature': sig, 'Content-Type':'application/x-www-form-urlencoded' }, body });
    const secondText = await second.text();
    expect(secondText).toMatch(/replay/);
  });
});
