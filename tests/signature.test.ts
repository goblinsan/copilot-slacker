import { describe, it, expect } from 'vitest';
import { verifySlackSignature } from '../src/slack.js';
import crypto from 'node:crypto';

describe('slack signature', () => {
  it('valid signature passes', () => {
    const secret = 'test';
    const ts = '123';
    const body = 'payload=test';
    const base = `v0:${ts}:${body}`;
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');
    expect(verifySlackSignature(secret, body, ts, sig)).toBe(true);
  });
});
