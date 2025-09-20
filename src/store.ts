import type { ApprovalRecord, GuardRequestRecord, PersonaSignalRecord, RequestStatus } from './types.js';
import crypto from 'node:crypto';

export interface IStore {
  createRequest(rec: Omit<GuardRequestRecord,'id'>): GuardRequestRecord | Promise<GuardRequestRecord>;
  getByToken(token: string): GuardRequestRecord | undefined | Promise<GuardRequestRecord | undefined>;
  getById(id: string): GuardRequestRecord | undefined | Promise<GuardRequestRecord | undefined>;
  updateStatus(id: string, from: RequestStatus[], to: RequestStatus): GuardRequestRecord | undefined | Promise<GuardRequestRecord | undefined>;
  addApproval(a: ApprovalRecord): void | Promise<void>;
  listApprovals(request_id: string): ApprovalRecord[] | Promise<ApprovalRecord[]>;
  setSlackMessage(id: string, channel: string, ts: string): void | Promise<void>;
  updatePersonaState(request_id: string, persona: string, state: 'ack'|'rejected', actor_slack_id: string): void | Promise<void>;
  hasApproval(request_id: string, actor: string): boolean | Promise<boolean>;
  approvalsFor(request_id: string): string[] | Promise<string[]>;
  listOpenRequests?(): Promise<GuardRequestRecord[]> | GuardRequestRecord[]; // non-terminal for scheduler
  updateFields?(id: string, patch: Partial<GuardRequestRecord>): void | Promise<void>;
  listLineageRequests?(lineage_id: string): GuardRequestRecord[] | Promise<GuardRequestRecord[]>;
}

// In-memory implementation (default)
function createMemoryStore(): IStore {
  const requests = new Map<string, GuardRequestRecord>();
  const approvals = new Map<string, ApprovalRecord[]>();
  const personaSignals = new Map<string, PersonaSignalRecord[]>();
  return {
    createRequest(rec) { const id = crypto.randomUUID(); const full: GuardRequestRecord = { ...rec, id }; requests.set(id, full); return full; },
    getByToken(token) { return [...requests.values()].find(r => r.token === token); },
    getById(id) { return requests.get(id); },
    updateStatus(id, from, to) { const r = requests.get(id); if(!r) return; if(!from.includes(r.status)) return; r.status = to; if(['approved','denied','expired'].includes(to)) r.decided_at = new Date().toISOString(); return r; },
    addApproval(a) { const list = approvals.get(a.request_id)||[]; list.push(a); approvals.set(a.request_id,list); const r = requests.get(a.request_id); if(r) r.approvals_count = list.filter(x=>x.decision==='approved').length; },
    listApprovals(id) { return approvals.get(id)||[]; },
    setSlackMessage(id, channel, ts) { const r = requests.get(id); if(r){ r.slack_channel=channel; r.slack_message_ts=ts; } },
    updatePersonaState(request_id, persona, state, actor_slack_id){ const list = personaSignals.get(request_id)||[]; let row = list.find(p=>p.persona===persona); const now = new Date().toISOString(); if(!row){ row={ id: crypto.randomUUID(), request_id, persona, actor_slack_id, state, created_at: now, updated_at: now }; list.push(row);} else { row.state=state; row.actor_slack_id=actor_slack_id; row.updated_at=now; } personaSignals.set(request_id,list); const req = requests.get(request_id); if(req) req.persona_state[persona]=state; },
    hasApproval(request_id, actor){ return (approvals.get(request_id)||[]).some(a=>a.actor_slack_id===actor && a.decision==='approved'); },
    approvalsFor(request_id){ return (approvals.get(request_id)||[]).filter(a=>a.decision==='approved').map(a=>a.actor_slack_id); },
    listOpenRequests(){ return [...requests.values()].filter(r => !['approved','denied','expired'].includes(r.status)); },
    updateFields(id, patch){ const r = requests.get(id); if(!r) return; Object.assign(r, patch); },
    listLineageRequests(lineage_id){ return [...requests.values()].filter(r => r.lineage_id === lineage_id); }
  };
}

let backend: IStore = createMemoryStore();

if (process.env.STORE_BACKEND === 'redis') {
  try {
    // @ts-ignore dynamic optional module
    const mod = await import('./store/redis.js');
    backend = await mod.createRedisStore();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[store] Failed to initialize redis backend, falling back to memory:', e);
  }
}

export const Store: IStore = backend;

export const __INTERNAL = { }; // memory-only internals removed for abstraction
