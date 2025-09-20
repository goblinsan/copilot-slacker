import { describe, it, expect, beforeAll, vi } from 'vitest';
import { enqueueUpdate, clearQueue } from '../src/slack-queue.js';
import { slackClient } from '../src/slack.js';

// We'll monkey patch slackClient.chat.update to count calls & capture last payload

describe('slack update queue (#39)', () => {
  beforeAll(() => {
    process.env.SLACK_UPDATE_QUEUE = 'true';
  });
  it('coalesces multiple rapid updates for same message', async () => {
    const calls: any[] = [];
    // @ts-ignore
    const orig = slackClient.chat.update;
    // @ts-ignore
    slackClient.chat.update = vi.fn(async (args) => { calls.push(args); return {}; });

    enqueueUpdate('C1','123',{ text: 'v1', blocks: [] });
    enqueueUpdate('C1','123',{ text: 'v2', blocks: [] });
    enqueueUpdate('C1','123',{ text: 'v3', blocks: [] });
    // different key should be separate call
    enqueueUpdate('C1','124',{ text: 'other', blocks: [] });

    await new Promise(r=>setTimeout(r, 250));

    // Expect only two calls: one for key C1:123 (latest v3) and one for C1:124
    expect(calls.length).toBe(2);
    const primary = calls.find(c=>c.ts==='123');
    expect(primary.text).toBe('v3');

    // restore
    // @ts-ignore
    slackClient.chat.update = orig;
    clearQueue();
  });
});
