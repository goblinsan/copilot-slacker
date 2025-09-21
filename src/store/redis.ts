import { createClient, RedisClientType } from 'redis';
import crypto from 'node:crypto';
import type { IStore } from '../store.js';
// Lazy import via dynamic require pattern is avoided; we import snapshot helper directly (circular safe: function only reads map)
import { getOptimisticSnapshot } from '../approval.js';

// Track live proxied references per request id for cross-object state synchronization (persona acks, etc.)
const liveRefs = new Map<string, Set<any>>();

// Fields that when mutated directly on returned request objects should be auto-persisted.
const MUTABLE_FIELDS = new Set([
  'status','approvals_count','decided_at','expires_at','escalate_at','escalation_fired','escalated_at','last_remaining_bucket','min_approvals'
]);

// Optional persona snapshot overlay (future: could be populated similarly to approvals). For now we just rely on redis persistence.
// Placeholder hook for symmetry if optimistic persona support added later.
function applyOptimisticPersonaOverlay(parsed: any) { /* no-op presently */ }
import type { ApprovalRecord, GuardRequestRecord, RequestStatus } from '../types.js';

/**
 * Redis store implementation.
 * Keys:
 *  req:{id} -> JSON GuardRequestRecord
 *  approvals:{id} -> JSON array of ApprovalRecord
 *  persona:{id} -> JSON hash of persona -> state
 */
export async function createRedisStore(): Promise<IStore> {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const client: RedisClientType = createClient({ url });
  await client.connect();

  function registerLive(id: string, obj: any) {
    let set = liveRefs.get(id); if(!set){ set = new Set(); liveRefs.set(id,set); }
    set.add(obj);
  }

  async function getRequest(id: string): Promise<GuardRequestRecord | undefined> {
    const raw = await client.get(`req:${id}`); if(!raw) return; const parsed: GuardRequestRecord = JSON.parse(raw);
    try {
      const snap = getOptimisticSnapshot(id);
      if (snap) {
        // Only overlay if parsed record has not yet observed the optimistic state (avoid regressing durable values)
        if (snap.approvals_count > (parsed as any).approvals_count) (parsed as any).approvals_count = snap.approvals_count;
        if (snap.status && parsed.status !== snap.status) parsed.status = snap.status as any;
        if (snap.decided_at && !parsed.decided_at) parsed.decided_at = snap.decided_at;
      }
    } catch { /* ignore snapshot overlay errors */ }
    try { applyOptimisticPersonaOverlay(parsed); } catch { /* ignore */ }
    // Wrap in proxy for auto-persist of mutable fields
    const proxied = new Proxy(parsed as any, {
      set(target, prop: any, value) {
        const prev = target[prop];
        target[prop] = value;
        if (MUTABLE_FIELDS.has(prop)) {
          // Schedule microtask persistence (coalesce bursts)
          queueMicrotask(() => {
            client.get(`req:${id}`).then(currRaw => {
              if(!currRaw) return;
              try {
                const curr = JSON.parse(currRaw);
                if (curr[prop] !== value) { curr[prop] = value; }
                // Also mirror any coupled fields (status->decided_at already mutated above)
                client.set(`req:${id}`, JSON.stringify(curr));
              } catch {/* ignore */}
            }).catch(()=>{});
          });
        }
        return true;
      }
    });
    registerLive(id, proxied);
    return proxied as GuardRequestRecord;
  }
  async function setRequest(r: GuardRequestRecord) {
    await client.set(`req:${r.id}`, JSON.stringify(r));
    if (r.expires_at) {
      const ttl = Math.max(5, Math.floor((new Date(r.expires_at).getTime() - Date.now())/1000));
      await client.expire(`req:${r.id}`, ttl + 120); // grace window
    }
  }
  const api: IStore = {
    async createRequest(rec) {
      const id = crypto.randomUUID();
      const full: GuardRequestRecord = { ...rec, id } as GuardRequestRecord;
      await setRequest(full);
      const proxied = await getRequest(id);
      // getRequest should always succeed immediately after set; fallback to original object if unexpected miss.
      return (proxied ?? full) as GuardRequestRecord;
    },
    async getByToken(token) { let cursor = 0; do { const scan = await client.scan(cursor, { MATCH: 'req:*', COUNT: 100 }); cursor = scan.cursor; for (const key of scan.keys) { const raw = await client.get(key); if(raw){ const obj: GuardRequestRecord = JSON.parse(raw); if (obj.token === token) { // persist any optimistic snapshot overlay via getRequest for consistent proxy semantics
      return await getRequest(obj.id); } } } } while (cursor !== 0); return undefined; },
    getById: getRequest,
    async updateStatus(id, from, to) { const r = await getRequest(id); if(!r) return; if(!from.includes(r.status)) return; r.status = to; if(['approved','denied','expired'].includes(to)) r.decided_at = new Date().toISOString(); await setRequest(r); return r; },
    async addApproval(a) { const key = `approvals:${a.request_id}`; const listRaw = await client.get(key); const list: ApprovalRecord[] = listRaw? JSON.parse(listRaw): []; list.push(a); await client.set(key, JSON.stringify(list)); const r = await getRequest(a.request_id); if(r){ r.approvals_count = list.filter(x=>x.decision==='approved').length; await setRequest(r);} },
    async listApprovals(id) { const raw = await client.get(`approvals:${id}`); return raw? JSON.parse(raw): []; },
    async setSlackMessage(id, channel, ts) { const r = await getRequest(id); if(r){ r.slack_channel=channel; r.slack_message_ts=ts; await setRequest(r);} },
    async updatePersonaState(request_id, persona, state, actor_slack_id) { const r = await getRequest(request_id); if(!r) return; r.persona_state[persona]=state; await setRequest(r); // sync other live refs
      const refs = liveRefs.get(request_id); if(refs){ for (const ref of refs){ try { if(ref!==r){ if(!ref.persona_state) ref.persona_state = {}; ref.persona_state[persona]=state; } } catch {} } } },
    async hasApproval(request_id, actor) { const list = await api.listApprovals(request_id) as ApprovalRecord[]; return list.some(a=>a.actor_slack_id===actor && a.decision==='approved'); },
    async approvalsFor(request_id) { const list = await api.listApprovals(request_id) as ApprovalRecord[]; return list.filter(a=>a.decision==='approved').map(a=>a.actor_slack_id); }
    ,
  async listOpenRequests() { const results: GuardRequestRecord[] = []; let cursor = 0; do { const scan = await client.scan(cursor,{ MATCH: 'req:*', COUNT: 100 }); cursor = scan.cursor; for (const key of scan.keys) { const raw = await client.get(key); if(!raw) continue; const obj: GuardRequestRecord = JSON.parse(raw); if(!['approved','denied','expired'].includes(obj.status)) results.push(obj); } } while (cursor !== 0); return results; },
    async updateFields(id, patch){ const r = await getRequest(id); if(!r) return; Object.assign(r, patch); await setRequest(r); }
    ,
    async listLineageRequests(lineage_id) { const results: GuardRequestRecord[] = []; let cursor = 0; do { const scan = await client.scan(cursor,{ MATCH: 'req:*', COUNT: 100 }); cursor = scan.cursor; for (const key of scan.keys) { const raw = await client.get(key); if(!raw) continue; const obj: GuardRequestRecord = JSON.parse(raw); if(obj.lineage_id === lineage_id) results.push(obj); } } while (cursor !== 0); return results; }
  };
  return api;
}
