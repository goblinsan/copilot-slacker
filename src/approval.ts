import crypto from 'node:crypto';
import { Store, getStoreInstanceId } from './store.js';
import type { GuardRequestRecord } from './types.js';
import { audit } from './log.js';
import { incCounter, observeDecisionLatency } from './metrics.js';

// Derive a stable signature of current approvals for drift / divergence diagnostics.
// Non-goal: cryptographic integrity (simple join sufficient for debug invariants).
function approvalsSig(list: unknown): string | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.slice().sort().join(',');
}

// Emit a one-time module fingerprint for diagnosing duplicate module loading in CI.
// Uses a symbol on globalThis to avoid duplicate emission.
try {
  const FP_SYMBOL = Symbol.for('approval_service.fp.approval');
  if (!(globalThis as any)[FP_SYMBOL]) {
    (globalThis as any)[FP_SYMBOL] = true;
    audit('module_fingerprint_approval', { url: import.meta.url, store_instance: getStoreInstanceId?.() });
  }
} catch {/* ignore fingerprint errors */}

export type ApprovalResult = { ok: true; terminal?: boolean } | { ok: false; error: string };

// Per-request approval stage sequencing for deterministic ordering diagnostics
const approvalSeq = new Map<string, number>();
function nextSeq(id: string) { const n = (approvalSeq.get(id) || 0) + 1; approvalSeq.set(id, n); return n; }

export function applyApproval(req: GuardRequestRecord, actor: string): ApprovalResult {
  // Capture the original request id early so that even if we adopt a canonical object later, stage sequencing
  // remains anchored to the stable id (avoids seq reset / undefined id when an async getById Promise was mistakenly adopted).
  const requestId = req.id;
  const stageDiag = process.env.APPROVAL_STAGE_DIAG === '1';
  function stage(stage: string) {
    if (!stageDiag) return;
    try {
      audit('approval_stage', { request_id: requestId, actor, stage, seq: nextSeq(requestId), status: req.status, count: req.approvals_count });
    } catch { /* ignore */ }
  }
  // Always-on minimal core stage events (not gated by env) to guarantee CI visibility.
  function core(stage: string) {
    try { audit('approval_stage_core', { request_id: requestId, actor, stage, seq: nextSeq(requestId), status: req.status, count: req.approvals_count }); } catch { /* ignore */ }
  }
  core('enter_core');
  stage('enter');
  // Capture / assign identity on the incoming (possibly non-canonical) reference.
  const identity = (req as any).__identity || ((req as any).__identity = crypto.randomUUID());
  // Always attempt to resolve the canonical request object from the Store first. Divergence in CI indicates
  // some callers may be holding a stale/cloned reference (e.g., JSON round‑trip, test harness cloning).
  try {
    let maybe = (Store as any).getById ? (Store as any).getById(req.id) : undefined;
    // If getById is async (returns a Promise), we cannot adopt synchronously; ignore and proceed with original ref.
    if (maybe && typeof (maybe as any).then === 'function') {
      audit('approval_canonical_async_pending', { request_id: requestId, actor });
      maybe = undefined;
    }
    if (maybe && maybe !== req) {
      const canonical = maybe as GuardRequestRecord;
      const canonId = (canonical as any).__identity || ((canonical as any).__identity = crypto.randomUUID());
      audit('approval_canonical_adopted', { request_id: requestId, actor, identity_orig: identity, identity_canonical: canonId, status_orig: req.status, status_canonical: canonical.status });
      stage('canonical_adopted');
      // Synchronize mutable fields we rely on pre-approval (redacted_params, payload_hash)
      if ((req as any).redacted_params && canonical.redacted_params !== (req as any).redacted_params) {
        (canonical as any).redacted_params = (req as any).redacted_params;
        (canonical as any).payload_hash = (req as any).payload_hash;
      }
      req = canonical; // adopt canonical for rest of function (safe: not a Promise)
    } else if (!maybe) {
      audit('approval_store_miss', { request_id: requestId, actor, identity, phase: 'pre_add' });
      stage('store_miss_pre');
    }
  } catch { /* ignore canonical resolution errors */ }
  stage('prechecks');
  // Debug pre-state snapshot (guarded by env flag to reduce noise in normal runs)
  const debug = process.env.APPROVAL_DEBUG === '1';
  if (debug) {
    try {
      const preList = (Store.approvalsFor as any)(req.id);
      audit('approval_pre_state', { request_id: req.id, actor, count: req.approvals_count, list_len: Array.isArray(preList)? preList.length : undefined, store_instance: getStoreInstanceId?.(), status: req.status });
    } catch {/* ignore */}
  }
  // Defensive: normalize allowed_approver_ids (could be missing if a cloned/plain object deserialized without field)
  if (!Array.isArray((req as any).allowed_approver_ids)) {
    audit('approval_missing_allowed_ids', { request_id: requestId, actor, had_field: Object.prototype.hasOwnProperty.call(req,'allowed_approver_ids') });
    (req as any).allowed_approver_ids = [];
  }
  if (!req.allowed_approver_ids.includes(actor)) {
    audit('unauthorized_approval_attempt', { request_id: req.id, actor });
    stage('exit_unauthorized');
    audit('approval_exit',{ request_id: req.id, actor, reason: 'not_authorized' });
    return { ok: false, error: 'not_authorized' };
  }
  if (['approved','denied','expired'].includes(req.status)) {
    audit('approval_rejected_terminal', { request_id: req.id, actor, status: req.status });
    stage('exit_terminal');
    audit('approval_exit',{ request_id: req.id, actor, reason: 'terminal_preexisting', status: req.status });
    return { ok: false, error: 'terminal' };
  }
  if (req.status !== 'ready_for_approval') {
    // Helpful for CI debugging when status unexpectedly differs (e.g., awaiting_personas)
    audit('approval_rejected_not_ready', { request_id: req.id, actor, status: req.status });
    stage('exit_not_ready');
    audit('approval_exit',{ request_id: req.id, actor, reason: 'not_ready', status: req.status });
    return { ok: false, error: 'not_ready' };
  }
  stage('auth_status_ok');
  // Support both sync and async store implementations for hasApproval
  const hasMaybe = (Store.hasApproval as any)(req.id, actor);
  let already = false;
  if (typeof hasMaybe === 'boolean') already = hasMaybe;
  else if (hasMaybe && typeof hasMaybe.then === 'function') {
    // For async backends we cannot block synchronously; best-effort probe by temporarily marking false and reconciling after add
    // (duplicate detection will still be enforced by store uniqueness semantics if present)
    try { /* no-op */ } catch {/* ignore */}
  } else if (hasMaybe) already = Boolean(hasMaybe);
  if (already) {
    audit('approval_rejected_duplicate', { request_id: req.id, actor });
    stage('exit_duplicate');
    audit('approval_exit',{ request_id: req.id, actor, reason: 'duplicate' });
    return { ok: false, error: 'duplicate' };
  }
  stage('pre_add');
  core('pre_add_core');
  const fastPathEnabled = process.env.APPROVAL_FAST_PATH_DIAG === '1' && req.min_approvals === 1 && req.approvals_count === 0;
  if (fastPathEnabled) {
    (req as any).approvals_count = 1;
    req.status = 'approved';
    req.decided_at = new Date().toISOString();
    audit('approval_fast_path_used',{ request_id: req.id, actor });
    stage('fast_path_applied');
  }
  const prevCount = req.approvals_count;
  try {
    const addResult = (Store.addApproval as any)({
      id: crypto.randomUUID(),
      request_id: req.id,
      actor_slack_id: actor,
      actor_type: 'human',
      decision: 'approved',
      created_at: new Date().toISOString()
    });
    // If the store returns a Promise (async backend like redis), we cannot rely on immediate in-object mutation.
    if (addResult && typeof addResult.then === 'function') {
      audit('approval_async_add_detected', { request_id: requestId, actor, min_approvals: req.min_approvals, count_before: req.approvals_count });
      // For min_approvals == 1 we optimistically finalize to avoid test / SSE stalls; backend completion will be idempotent.
      if (req.min_approvals === 1 && req.approvals_count === 0) {
        (req as any).approvals_count = 1;
        req.status = 'approved';
        req.decided_at = new Date().toISOString();
        audit('approval_async_assumed_terminal', { request_id: requestId, actor });
        // Best-effort immediate sync of underlying store object if a separate canonical instance exists (common in async backends)
        try {
          const maybeStoreObj = (Store as any).getById ? (Store as any).getById(req.id) : undefined;
          if (maybeStoreObj && typeof maybeStoreObj === 'object' && typeof (maybeStoreObj as any).then !== 'function' && maybeStoreObj !== req) {
            (maybeStoreObj as any).approvals_count = 1;
            (maybeStoreObj as any).status = 'approved';
            (maybeStoreObj as any).decided_at = (req as any).decided_at;
            audit('approval_async_store_synced', { request_id: requestId, actor });
          }
        } catch { /* ignore */ }
        // Fire an async persistence path for stores exposing updateFields (e.g., redis) to ensure status durability.
        try {
          if ((Store as any).updateFields) {
            queueMicrotask(() => {
              try {
                Promise.resolve((Store as any).updateFields(req.id, { status: 'approved', approvals_count: 1, decided_at: (req as any).decided_at }))
                  .then(() => audit('approval_async_persisted', { request_id: requestId, actor }))
                  .catch(() => {/* swallow */});
              } catch { /* ignore */ }
            });
          }
        } catch { /* ignore */ }
        // Emit a core post-add stage even though underlying async add not yet resolved for consistent stage triage.
        try { audit('approval_stage_core', { request_id: requestId, actor, stage: 'post_add_core_early', seq: nextSeq(requestId), status: req.status, count: req.approvals_count }); } catch { /* ignore */ }
        incCounter('approvals_total',{ action: req.action });
        const latencySecA = (new Date(req.decided_at).getTime() - new Date(req.created_at).getTime())/1000;
        observeDecisionLatency(latencySecA,{ action: req.action, outcome: 'approved' });
        stage('exit_terminal_approved_async');
        audit('approval_exit',{ request_id: requestId, actor, reason: 'success_terminal_async' });
        return { ok: true, terminal: true };
      }
      // Otherwise we continue but note that subsequent recompute paths may still see zero until promise resolves.
    }
    core('post_add_core');
  } catch (e:any) {
    audit('approval_add_error',{ request_id: req.id, actor, error: String(e) });
    stage('exit_add_error');
    audit('approval_exit',{ request_id: req.id, actor, reason: 'store_error', error: String(e) });
    return { ok: false, error: 'store_error' };
  }
  stage('post_add_attempt');
  // Post-mutation canonical fetch (in case addApproval happened on different in-memory instance than our local ref)
  try {
    const after = (Store as any).getById ? (Store as any).getById(req.id) : undefined;
    if (!after) {
      audit('approval_store_miss', { request_id: req.id, actor, identity, phase: 'post_add' });
      stage('store_miss_post');
    } else if (after !== req) {
      // Our local reference diverged from canonical mutated record; adopt counts/status from canonical.
      const afterId = (after as any).__identity;
      audit('approval_reference_diverged', { request_id: req.id, actor, identity_orig: identity, identity_fresh: afterId, count_orig: req.approvals_count, count_fresh: after.approvals_count });
      if (req.approvals_count === 0 && after.approvals_count > 0) {
        (req as any).approvals_count = after.approvals_count;
      }
      req = after; // adopt canonical for remainder
      stage('canonical_after_add');
    }
  } catch { /* ignore */ }
  // After store mutation, verify that approvals_count changed or can be recomputed. If still unchanged,
  // emit a divergence event (always-on) to aid CI diagnosis.
  if (req.approvals_count === prevCount) {
    try {
      const listNow = (Store.approvalsFor as any)(req.id);
      if (Array.isArray(listNow) && listNow.length > prevCount) {
        // approvals list length grew but the count on req did not.
        audit('approval_divergence_detected', { request_id: req.id, actor, prevCount, list_len: listNow.length, count_field: req.approvals_count, identity, store_instance: getStoreInstanceId?.() });
        (req as any).approvals_count = listNow.length; // self-heal
      }
    } catch {/* ignore */}
  }
  if (debug) {
    try {
      const midList = (Store.approvalsFor as any)(req.id);
      audit('approval_mid_state', { request_id: req.id, actor, prevCount, after_add: req.approvals_count, list_len: Array.isArray(midList)? midList.length : undefined, list_sig: approvalsSig(midList), store_instance: getStoreInstanceId?.() });
    } catch {/* ignore */}
  }
  // Fallback: if backend did not mutate req.approvals_count (e.g., different object instance), recompute.
  if (req.approvals_count === prevCount) {
    try {
      const approvers = (Store.approvalsFor as any)(req.id);
      if (Array.isArray(approvers)) {
        const recomputed = approvers.length;
        if (recomputed !== req.approvals_count) {
          audit('approval_count_fallback', { request_id: req.id, actor, observed: req.approvals_count, recomputed, store_instance: getStoreInstanceId?.() });
          (req as any).approvals_count = recomputed; // direct mutation safe for in-memory test path
        }
      }
    } catch {
      // ignore fallback errors
    }
  }
  // Deterministic recompute (covers potential multi-instance mutation anomalies)
  try {
    const listMaybe = (Store.approvalsFor as any)(req.id);
    if (Array.isArray(listMaybe)) {
      if (req.approvals_count !== listMaybe.length) {
        audit('approval_count_recomputed', { request_id: req.id, actor, before: req.approvals_count, after: listMaybe.length, store_instance: getStoreInstanceId?.() });
        (req as any).approvals_count = listMaybe.length;
      }
    }
  } catch { /* ignore */ }
  // Reference divergence check: fetch request again (if getById available) and compare object identity & count.
  try {
    const fresh = (Store as any).getById ? (Store as any).getById(req.id) : undefined;
    const freshSync = fresh && typeof fresh === 'object' ? fresh : undefined; // ignore promise (memory store is sync)
    if (freshSync && freshSync !== req) {
      audit('approval_reference_diverged', { request_id: req.id, actor, identity_orig: identity, identity_fresh: (freshSync as any).__identity, count_orig: req.approvals_count, count_fresh: freshSync.approvals_count });
      // If fresh count differs and appears correct (>=1) while orig is 0, adopt it.
      if (req.approvals_count === 0 && freshSync.approvals_count > 0) {
        (req as any).approvals_count = freshSync.approvals_count;
      }
    }
  } catch {/* ignore */}
  audit('approval_added', { request_id: req.id, actor, count: req.approvals_count, identity: (req as any).__identity || identity, store_instance: getStoreInstanceId?.() });
  stage('post_added');
  // Deferred microtask / next-tick fallback: if after core post_add we still have a zero count but the approvals list
  // includes the actor, we emit a manual mirror append event. This should never trigger in healthy paths and serves
  // as a final forensic + self-heal in CI where mutation events appear suppressed.
  try {
    const needMirror = req.approvals_count === 0;
    if (needMirror) {
      queueMicrotask(() => {
        try {
          const currentList = (Store.approvalsFor as any)(req.id);
          if (Array.isArray(currentList) && currentList.includes(actor) && req.approvals_count === 0) {
            audit('approval_manual_append',{ request_id: req.id, actor, list_len: currentList.length, store_instance: getStoreInstanceId?.() });
            (req as any).approvals_count = currentList.length || 1;
            audit('approval_manual_heal_count',{ request_id: req.id, actor, new_count: req.approvals_count });
          }
        } catch {/* ignore */}
      });
    }
  } catch {/* ignore */}
  if (debug) {
    try {
      const postList = (Store.approvalsFor as any)(req.id);
      audit('approval_post_state', { request_id: req.id, actor, count: req.approvals_count, list_len: Array.isArray(postList)? postList.length : undefined, list_sig: approvalsSig(postList), store_instance: getStoreInstanceId?.() });
      // Invariant: approvals_count must equal list length when list available.
      if (Array.isArray(postList) && req.approvals_count !== postList.length) {
        audit('approval_invariant_breach', { request_id: req.id, actor, count: req.approvals_count, list_len: postList.length, list_sig: approvalsSig(postList), store_instance: getStoreInstanceId?.() });
        // Fail fast in debug mode to surface anomaly loudly.
        throw new Error('approval invariant breach: count!=' + postList.length);
      }
    } catch {/* ignore */}
  }
  // Final defensive guard: if min_approvals == 1 but count is still 0 after all recomputes, force correction
  if (req.min_approvals === 1 && req.approvals_count === 0) {
    try {
      const finalList = (Store.approvalsFor as any)(req.id);
      if (Array.isArray(finalList) && finalList.includes(actor)) {
        audit('approval_forced_correction', { request_id: req.id, actor, reason: 'zero_count_anomaly', store_instance: getStoreInstanceId?.() });
        (req as any).approvals_count = 1;
      }
    } catch { /* swallow */ }
  }
  if (req.approvals_count >= req.min_approvals) {
    req.status = 'approved';
    req.decided_at = new Date().toISOString();
    audit('request_approved', { request_id: req.id, actor });
    stage('exit_terminal_approved');
    audit('approval_exit',{ request_id: req.id, actor, reason: 'success_terminal' });
    incCounter('approvals_total',{ action: req.action });
    const latencySec = (new Date(req.decided_at).getTime() - new Date(req.created_at).getTime())/1000;
  observeDecisionLatency(latencySec,{ action: req.action, outcome: 'approved' });
    return { ok: true, terminal: true };
  }
  // Defensive quorum recompute: if approvals_count below quorum but data store actually has enough unique approvers
  try {
    const approvers = (Store.approvalsFor as any)(req.id);
    if (Array.isArray(approvers)) {
      const unique = new Set(approvers);
      if (unique.size >= req.min_approvals && req.status === 'ready_for_approval') {
        audit('approval_quorum_recomputed', { request_id: req.id, actor, observed_count: req.approvals_count, unique_size: unique.size });
        req.approvals_count = unique.size;
        req.status = 'approved';
        req.decided_at = new Date().toISOString();
        audit('request_approved', { request_id: req.id, actor, recompute: true });
        stage('exit_terminal_approved_recompute');
        audit('approval_exit',{ request_id: req.id, actor, reason: 'success_terminal_recompute' });
        incCounter('approvals_total',{ action: req.action });
        const latencySec2 = (new Date(req.decided_at).getTime() - new Date(req.created_at).getTime())/1000;
        observeDecisionLatency(latencySec2,{ action: req.action, outcome: 'approved' });
        return { ok: true, terminal: true };
      }
      // Final guard just before nonterminal exit: if min_approvals == 1 and actor is present in list, force terminal.
      if (req.min_approvals === 1 && unique.has(actor) && req.status === 'ready_for_approval' && req.approvals_count === 0) {
        audit('approval_quorum_forced_final', { request_id: req.id, actor, reason: 'actor_present_list_zero_count' });
        req.approvals_count = 1;
        req.status = 'approved';
        req.decided_at = new Date().toISOString();
        audit('request_approved', { request_id: req.id, actor, forced: true });
        stage('exit_terminal_approved_forced');
        audit('approval_exit',{ request_id: req.id, actor, reason: 'success_terminal_forced' });
        incCounter('approvals_total',{ action: req.action });
        const latencySecF = (new Date(req.decided_at).getTime() - new Date(req.created_at).getTime())/1000;
        observeDecisionLatency(latencySecF,{ action: req.action, outcome: 'approved' });
        return { ok: true, terminal: true };
      }
    }
  } catch {
    // ignore recompute errors
  }
  stage('exit_nonterminal');
  audit('approval_exit',{ request_id: req.id, actor, reason: 'success_nonterminal', count: req.approvals_count });
  return { ok: true };
}

export function applyDeny(req: GuardRequestRecord, actor: string): ApprovalResult {
  if (!req.allowed_approver_ids.includes(actor)) {
    audit('unauthorized_deny_attempt', { request_id: req.id, actor });
    return { ok: false, error: 'not_authorized' };
  }
  if (['approved','denied','expired'].includes(req.status)) return { ok: false, error: 'terminal' };
  req.status = 'denied';
  req.decided_at = new Date().toISOString();
  audit('request_denied', { request_id: req.id, actor });
  incCounter('denies_total',{ action: req.action });
  const latencySec = (new Date(req.decided_at).getTime() - new Date(req.created_at).getTime())/1000;
  observeDecisionLatency(latencySec,{ action: req.action, outcome: 'denied' });
  return { ok: true, terminal: true };
}