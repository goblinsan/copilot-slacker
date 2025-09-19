import type { ApprovalRecord, GuardRequestRecord, PersonaSignalRecord, RequestStatus } from './types.js';
import crypto from 'node:crypto';

// Simple in-memory store (replace with Redis adapter in production)
// Provides optimistic state transitions.

const requests = new Map<string, GuardRequestRecord>();
const approvals = new Map<string, ApprovalRecord[]>();
const personaSignals = new Map<string, PersonaSignalRecord[]>();

export const Store = {
  createRequest(rec: Omit<GuardRequestRecord,'id'>): GuardRequestRecord {
    const id = crypto.randomUUID();
    const full: GuardRequestRecord = { ...rec, id };
    requests.set(id, full);
    return full;
  },
  getByToken(token: string): GuardRequestRecord | undefined {
    return [...requests.values()].find(r => r.token === token);
  },
  updateStatus(id: string, from: RequestStatus[], to: RequestStatus): GuardRequestRecord | undefined {
    const r = requests.get(id); if (!r) return; if (!from.includes(r.status)) return; r.status = to; if(['approved','denied','expired'].includes(to)) r.decided_at = new Date().toISOString(); return r;
  },
  addApproval(a: ApprovalRecord) {
    const list = approvals.get(a.request_id) || []; list.push(a); approvals.set(a.request_id, list);
  },
  listApprovals(request_id: string): ApprovalRecord[] { return approvals.get(request_id) || []; },
  setSlackMessage(id: string, channel: string, ts: string) { const r = requests.get(id); if (r) { r.slack_channel = channel; r.slack_message_ts = ts; } },
  updatePersonaState(request_id: string, persona: string, state: 'ack'|'rejected', actor_slack_id: string) {
    const list = personaSignals.get(request_id) || [];
    let row = list.find(p => p.persona === persona);
    const now = new Date().toISOString();
    if (!row) { row = { id: crypto.randomUUID(), request_id, persona, actor_slack_id, state, created_at: now, updated_at: now }; list.push(row); }
    else { row.state = state; row.actor_slack_id = actor_slack_id; row.updated_at = now; }
    personaSignals.set(request_id, list);
    const req = requests.get(request_id); if (req) { req.persona_state[persona] = state; }
  }
};
