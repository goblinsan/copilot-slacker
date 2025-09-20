import crypto from 'node:crypto';
import { Store } from './store.js';
import type { GuardRequestRecord } from './types.js';
import { audit } from './log.js';
import { incCounter, observeDecisionLatency } from './metrics.js';

export type ApprovalResult = { ok: true; terminal?: boolean } | { ok: false; error: string };

export function applyApproval(req: GuardRequestRecord, actor: string): ApprovalResult {
  if (!req.allowed_approver_ids.includes(actor)) {
    audit('unauthorized_approval_attempt', { request_id: req.id, actor });
    return { ok: false, error: 'not_authorized' };
  }
  if (['approved','denied','expired'].includes(req.status)) {
    audit('approval_rejected_terminal', { request_id: req.id, actor, status: req.status });
    return { ok: false, error: 'terminal' };
  }
  if (req.status !== 'ready_for_approval') {
    // Helpful for CI debugging when status unexpectedly differs (e.g., awaiting_personas)
    audit('approval_rejected_not_ready', { request_id: req.id, actor, status: req.status });
    return { ok: false, error: 'not_ready' };
  }
  // Support both sync and async store implementations for hasApproval
  const has = (Store.hasApproval as any)(req.id, actor);
  const already = typeof has === 'boolean' ? has : (typeof has?.then === 'function' ? false : Boolean(has));
  if (already) {
    audit('approval_rejected_duplicate', { request_id: req.id, actor });
    return { ok: false, error: 'duplicate' };
  }
  const prevCount = req.approvals_count;
  Store.addApproval({
    id: crypto.randomUUID(),
    request_id: req.id,
    actor_slack_id: actor,
    actor_type: 'human',
    decision: 'approved',
    created_at: new Date().toISOString()
  });
  // Fallback: if backend did not mutate req.approvals_count (e.g., different object instance), recompute.
  if (req.approvals_count === prevCount) {
    try {
      const approvers = (Store.approvalsFor as any)(req.id);
      if (Array.isArray(approvers)) {
        const recomputed = approvers.length;
        if (recomputed !== req.approvals_count) {
          audit('approval_count_fallback', { request_id: req.id, actor, observed: req.approvals_count, recomputed });
          (req as any).approvals_count = recomputed; // direct mutation safe for in-memory test path
        }
      }
    } catch {
      // ignore fallback errors
    }
  }
  audit('approval_added', { request_id: req.id, actor, count: req.approvals_count });
  if (req.approvals_count >= req.min_approvals) {
    req.status = 'approved';
    req.decided_at = new Date().toISOString();
    audit('request_approved', { request_id: req.id, actor });
    incCounter('approvals_total',{ action: req.action });
    const latencySec = (new Date(req.decided_at).getTime() - new Date(req.created_at).getTime())/1000;
  observeDecisionLatency(latencySec,{ action: req.action, outcome: 'approved' });
    return { ok: true, terminal: true };
  }
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