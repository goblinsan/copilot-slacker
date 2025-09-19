import crypto from 'node:crypto';
import { WebClient } from '@slack/web-api';
import type { GuardRequestRecord } from './types.js';

const slackToken = process.env.SLACK_BOT_TOKEN || '';
export const slackClient = new WebClient(slackToken);

export function verifySlackSignature(signingSecret: string, body: string, timestamp: string, signature: string): boolean {
  const base = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  const expected = `v0=${hmac}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function postRequestMessage(req: GuardRequestRecord, channel: string) {
  const header = `Guard Request: ${req.action}`;
  const personaLine = req.required_personas.length ? `Personas: ${req.required_personas.join(', ')}` : 'No persona gating';
  const r = await slackClient.chat.postMessage({
    channel,
    text: header,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: header } },
      { type: 'context', elements: [ { type: 'mrkdwn', text: `Repo: *${req.meta.origin.repo}* Branch: *${req.meta.origin.branch || ''}*` }, { type: 'mrkdwn', text: `Requester: ${req.meta.requester.display || req.meta.requester.id}` } ] },
      { type: 'section', fields: [ { type: 'mrkdwn', text: `*Action*\n${req.action}`}, { type: 'mrkdwn', text: `*Justification*\n${req.meta.justification}` } ] },
      { type: 'section', text: { type: 'mrkdwn', text: `Status: ${req.status} • ${personaLine}` } },
      { type: 'actions', block_id: 'approval_actions', elements: [
        { type: 'button', action_id: 'approve', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', value: req.id },
        { type: 'button', action_id: 'deny', text: { type: 'plain_text', text: 'Deny' }, style: 'danger', value: req.id }
      ] }
    ]
  });
  return { channel: r.channel!, ts: r.ts! };
}

export async function updateRequestMessage(req: GuardRequestRecord) {
  if(!req.slack_channel || !req.slack_message_ts) return;
  const header = `Guard Request: ${req.action}`;
  const personaLine = req.required_personas.length ? `Personas: ${req.required_personas.map(p=>`${p}:${req.persona_state[p]}`).join(', ')}` : 'No persona gating';
  const statusLine = `Status: *${req.status.toUpperCase()}*`;
  await slackClient.chat.update({
    channel: req.slack_channel,
    ts: req.slack_message_ts,
    text: header,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: header } },
      { type: 'context', elements: [ { type: 'mrkdwn', text: `Repo: *${req.meta.origin.repo}* Branch: *${req.meta.origin.branch || ''}*` }, { type: 'mrkdwn', text: `Requester: ${req.meta.requester.display || req.meta.requester.id}` } ] },
      { type: 'section', fields: [ { type: 'mrkdwn', text: `*Action*\n${req.action}`}, { type: 'mrkdwn', text: `*Justification*\n${req.meta.justification}` } ] },
      { type: 'section', text: { type: 'mrkdwn', text: `${statusLine} • ${personaLine}` } },
      ...(req.status === 'ready_for_approval' || req.status === 'awaiting_personas' ? [
        { type: 'actions', block_id: 'approval_actions', elements: [
          { type: 'button', action_id: 'approve', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', value: req.id, },
          { type: 'button', action_id: 'deny', text: { type: 'plain_text', text: 'Deny' }, style: 'danger', value: req.id }
        ] }
      ]: [])
    ]
  });
}
