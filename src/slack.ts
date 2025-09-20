import crypto from 'node:crypto';
import { WebClient } from '@slack/web-api';
import type { GuardRequestRecord } from './types.js';

const slackToken = process.env.SLACK_BOT_TOKEN || '';
export const slackClient = new WebClient(slackToken);

export function verifySlackSignature(signingSecret: string, body: string, timestamp: string, signature: string): boolean {
  const base = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  const expected = `v0=${hmac}`;
  if (!signature || !signature.startsWith('v0=')) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function postRequestMessage(req: GuardRequestRecord, channel: string) {
  const header = `Guard Request: ${req.action}`;
  const personaBlocks = buildPersonaBlocks(req);
  const r = await slackClient.chat.postMessage({
    channel,
    text: header,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: header } },
      { type: 'context', elements: [ { type: 'mrkdwn', text: `Repo: *${req.meta.origin.repo}* Branch: *${req.meta.origin.branch || ''}*` }, { type: 'mrkdwn', text: `Requester: ${req.meta.requester.display || req.meta.requester.id}` } ] },
      { type: 'section', fields: [ { type: 'mrkdwn', text: `*Action*\n${req.action}`}, { type: 'mrkdwn', text: `*Justification*\n${req.meta.justification}` } ] },
      ...personaBlocks.body,
      ...actionButtons(req)
    ]
  });
  return { channel: r.channel!, ts: r.ts! };
}

export async function updateRequestMessage(req: GuardRequestRecord) {
  if(!req.slack_channel || !req.slack_message_ts) return;
  const header = `Guard Request: ${req.action}`;
  const personaBlocks = buildPersonaBlocks(req);
  const remaining = timeRemainingLine(req);
  await slackClient.chat.update({
    channel: req.slack_channel,
    ts: req.slack_message_ts,
    text: header,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: header } },
      { type: 'context', elements: [ { type: 'mrkdwn', text: `Repo: *${req.meta.origin.repo}* Branch: *${req.meta.origin.branch || ''}*` }, { type: 'mrkdwn', text: `Requester: ${req.meta.requester.display || req.meta.requester.id}` }, ...(remaining? [{ type:'mrkdwn', text: remaining }]:[]) ] },
      { type: 'section', fields: [ { type: 'mrkdwn', text: `*Action*\n${req.action}`}, { type: 'mrkdwn', text: `*Justification*\n${req.meta.justification}` } ] },
      ...personaBlocks.body,
      ...actionButtons(req)
    ]
  });
}

export async function postEscalationNotice(req: GuardRequestRecord) {
  // Post a threaded escalation warning referencing imminent expiration.
  if(!req.slack_channel || !req.slack_message_ts) return;
  try {
    const remainingMs = new Date(req.expires_at).getTime() - Date.now();
    const minutes = Math.max(0, Math.round(remainingMs/60000));
    await slackClient.chat.postMessage({
      channel: req.slack_channel,
      thread_ts: req.slack_message_ts,
      text: `:warning: Escalation: Request *${req.action}* will expire in ~${minutes}m. Approvals needed: ${req.approvals_count}/${req.min_approvals}.`
    });
  } catch {/* swallow */}
}

function buildPersonaBlocks(req: GuardRequestRecord) {
  const approverLine = `Approvals: ${req.approvals_count}/${req.min_approvals}`;
  const statusLine = `Status: *${req.status.toUpperCase()}*`;
  if (!req.required_personas.length) {
    return { body: [ { type: 'section', text: { type: 'mrkdwn', text: `${statusLine} • ${approverLine}` } } ] };
  }
  const checklist = req.required_personas.map(p => {
    const st = req.persona_state[p];
    const emoji = st === 'ack' ? '✅' : (st === 'rejected' ? '❌' : '▫️');
    return `${emoji} *${p}*`;
  }).join('\n');
  return {
    body: [
      { type: 'section', text: { type: 'mrkdwn', text: `${statusLine} • ${approverLine}` } },
      { type: 'context', elements: [ { type: 'mrkdwn', text: '*Personas Required*' } ] },
      { type: 'section', text: { type: 'mrkdwn', text: checklist } },
      { type: 'actions', block_id: 'persona_actions', elements: req.required_personas.filter(p => req.persona_state[p] === 'pending').map(p => ({
        type: 'button', action_id: `persona_ack:${p}`, text: { type: 'plain_text', text: `Ack ${p}` }, value: req.id
      })) }
    ]
  };
}

function actionButtons(req: GuardRequestRecord) {
  const ready = req.status === 'ready_for_approval';
  if (req.status === 'approved' || req.status === 'denied' || req.status === 'expired') return [];
  const approveBtn = { type: 'button', action_id: 'approve', text: { type: 'plain_text', text: ready ? 'Approve' : 'Approve (waiting personas)' }, style: 'primary', value: req.id, ...(ready ? {} : { disabled: true }) } as any;
  const denyBtn = { type: 'button', action_id: 'deny', text: { type: 'plain_text', text: 'Deny' }, style: 'danger', value: req.id } as any;
  return [ { type: 'actions', block_id: 'approval_actions', elements: [approveBtn, denyBtn] } ];
}

function timeRemainingLine(req: GuardRequestRecord): string | undefined {
  if (['approved','denied','expired'].includes(req.status)) return undefined;
  const remainingMs = new Date(req.expires_at).getTime() - Date.now();
  if (remainingMs <= 0) return undefined;
  const mins = Math.floor(remainingMs / 60000);
  const secs = Math.floor((remainingMs % 60000)/1000);
  return `Remaining: ${mins}m ${secs}s`;
}
