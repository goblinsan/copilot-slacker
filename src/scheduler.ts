import { Store } from './store.js';
import { audit } from './log.js';
import { updateRequestMessage, postEscalationNotice } from './slack.js';
import { incCounter, observeDecisionLatency } from './metrics.js';
import { broadcastForRequestId } from './sse.js';
import { withSpan } from './tracing.js';

/**
 * Periodic scheduler to expire requests and (future) trigger escalation warnings.
 * Interval precedence: explicit param > env SCHEDULER_INTERVAL_MS > default (5000ms).
 */
let timer: NodeJS.Timeout | undefined;

export function startScheduler(intervalOverride?: number) {
  if (timer) return; // idempotent
  const interval = intervalOverride ?? Number(process.env.SCHEDULER_INTERVAL_MS || 5000);
  timer = setInterval(async () => {
    if (!Store.listOpenRequests) return; // backend may not support listing
    try {
      const open = await Store.listOpenRequests();
      const now = Date.now();
      for (const r of open) {
        const exp = new Date(r.expires_at).getTime();
        // Fire escalation first (single-fire) if threshold passed but not terminal/expired
  if (!r.escalation_fired && r.escalate_at && !['approved','denied','expired'].includes(r.status)) {
          const escAt = new Date(r.escalate_at).getTime();
            if (now >= escAt && now < exp) {
              r.escalation_fired = true;
              r.escalated_at = new Date().toISOString();
              if (r.escalate_min_approvals && r.escalate_min_approvals > r.min_approvals) {
                r.min_approvals = r.escalate_min_approvals;
              }
              await withSpan('scheduler.escalate', async span => {
                span.setAttribute?.('request_id', r.id);
                span.setAttribute?.('action', r.action);
                audit('request_escalated',{ request_id: r.id });
              });
              incCounter('escalations_total',{ action: r.action });
              try { if ((Store as any).updateFields) { await (Store as any).updateFields(r.id, { escalation_fired: true, escalated_at: r.escalated_at, min_approvals: r.min_approvals }); } } catch {/* ignore */}
              await postEscalationNotice(r);
              broadcastForRequestId(r.id);
            }
        }
        // Remaining time dynamic minute bucket update (only if non-terminal)
        if (!['approved','denied','expired'].includes(r.status)) {
          const remainingMs = exp - now;
          if (remainingMs > 0) {
            const bucket = Math.max(0, Math.floor(remainingMs / 60000));
            if (r.last_remaining_bucket === undefined || bucket < r.last_remaining_bucket) {
              r.last_remaining_bucket = bucket;
              // Refresh Slack message to show updated remaining time
              await updateRequestMessage(r);
            }
          }
        }
        if (r.status !== 'expired' && now >= exp && !['approved','denied','expired'].includes(r.status)) {
          await withSpan('scheduler.expire', async span => {
            r.status = 'expired';
            r.decided_at = new Date().toISOString();
            span.setAttribute?.('request_id', r.id);
            span.setAttribute?.('action', r.action);
            audit('request_expired',{ request_id: r.id });
          });
          incCounter('expired_total',{ action: r.action });
          if (r.created_at) {
            const created = new Date(r.created_at).getTime();
            observeDecisionLatency((now - created)/1000, { action: r.action, outcome: 'expired' });
          }
          try { if ((Store as any).updateFields) { await (Store as any).updateFields(r.id, { status: 'expired', decided_at: r.decided_at }); } } catch {/* ignore */}
          await updateRequestMessage(r);
          broadcastForRequestId(r.id);
          continue;
        }
      }
    } catch (e) {
      audit('scheduler_error',{ error: String(e) });
    }
  }, interval);
}

export function stopScheduler() { if (timer) { clearInterval(timer); timer = undefined; } }