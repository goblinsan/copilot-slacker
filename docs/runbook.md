# Operational Runbook – Approval Service

Status: Living Document  
Owner: Platform / Infra Team  
Last Updated: 2025-09-20

## 1. Purpose
Guide on-call and platform engineers through routine operations, incident response, and reliability tasks for the Approval Service (Slack Guard).

## 2. System Overview
The service mediates risky agent / automation actions by requiring human approval through Slack. Core components:
- HTTP API (Node.js/TypeScript, ESM)
- Policy engine (YAML based)
- Store (memory or Redis)
- Slack integration (interactive components, modal overrides)
- Scheduler (timeouts, escalations)
- Retention & archival sweeper
- Metrics (/metrics), Tracing (OTel), Audit logging

## 3. Key Data Flows
1. Request created → stored → Slack message posted → waiting personas / approvals.
2. Personas acknowledge (if required) → approval enabled.
3. User approves/denies via Slack → state transition → decision latency histogram updated → SSE / poll clients notified.
4. Timeout path: scheduler escalates (once) then expires request.
5. Archival: terminal requests older than `RETENTION_MAX_AGE_SEC` archived → purged.

## 4. Critical Environment Variables
| Var | Purpose | Notes |
|-----|---------|-------|
| SLACK_SIGNING_SECRET | Verify Slack signatures | Mandatory prod |
| SLACK_BOT_TOKEN | Post & update Slack messages | Mandatory prod |
| STORE_BACKEND | `memory` or `redis` | Use `redis` for multi-pod |
| REDIS_URL | Redis connection URL | Required when STORE_BACKEND=redis |
| POLICY_PATH | Path to policy YAML | ConfigMap mount in k8s |
| TRACING_ENABLED / TRACING_EXPORTER | Enable OTEL spans | Exporter `console|otlp` |
| RETENTION_MAX_AGE_SEC | Terminal retention window | Governs archival/purge |
| RETENTION_SWEEP_INTERVAL_SEC | Sweep cadence | Tuning impacts load |
| OVERRIDE_MAX_KEYS / OVERRIDE_MAX_CHARS | Override governance | Prevent large diffs |
| RATE_LIMIT_CAPACITY / RATE_LIMIT_REFILL_PER_SEC | Request spam control | Per-IP token bucket |
| ADMIN_TOKEN | Protect admin endpoints | Policy reload & future ops |

## 5. Secrets Rotation Procedure
1. Generate new Slack Bot token / signing secret in Slack admin console.
2. Store secrets in secret manager / Kubernetes Secret (do not commit).
3. Update deployment (blue/green or rolling) injecting new values alongside old (if dual support needed).
4. Confirm `/healthz` & `/readyz` pass across all pods.
5. Trigger policy reload to ensure runtime sees any secret-dependent config if applicable (not usually required for Slack creds).
6. Revoke old Slack token.
7. Audit: verify no `bad_signature` or auth failures spiking after rotation.

## 6. Policy Reload
- Via Admin API: `POST /api/admin/reload-policy` with header `x-admin-token: <ADMIN_TOKEN>`.
- Via Signal: Send `SIGHUP` (Unix) to the main process PID (container orchestrator may not expose; prefer API in k8s).
- Verification: Audit event `policy_reloaded` contains new `hash`. Confirm metric `policy_reloads_total{source="api"}` incremented.
- Rollback: Revert policy file; reload again.

## 7. Redis Failover / Outage Handling
| Scenario | Symptom | Action |
|----------|---------|--------|
| Primary Redis down | Approvals stall / new creates slow | Fallback currently memory only if restart; investigate connectivity |
| High latency | Slow request creation | Check network, Redis CPU, keyspace hits/misses |
| Data divergence (multi-pod) | Mismatched request state | Ensure all pods using Redis (no memory fallback logs) |

Diagnostics:
```bash
redis-cli -u $REDIS_URL INFO stats | egrep 'instantaneous_ops_per_sec|keyspace_hits|keyspace_misses'
```
Look for log warnings: `[store] Failed to initialize redis backend`.

## 8. Escalation & Timeout Tuning
- `expires_at` set per request (policy-driven or default?).
- Escalation occurs once at `escalate_at` (if configured) — ensure scheduler interval small relative to SLA (default 5s). Decrease via env `SCHEDULER_INTERVAL_MS` if drift > acceptable.
- Track `expired_total` & decision latency histogram tail for missed SLAs.

## 9. Latency SLO Investigation
Path: Create latency (HTTP) + processing overhead.
Checklist:
1. Check p95 `decision_latency_seconds` for `approved` vs `denied` — large disparity may indicate Slack delays.
2. Inspect tracing spans (creation → approval) for outliers (OTLP backend).
3. Validate absence of GC pauses (use Node diag flags in staging if needed).
4. Confirm Redis not saturated (latency spikes, connection limits).
5. Re-run load harness (`npm run load-sim`) to isolate server-side vs Slack integration overhead (Slack disabled path ideally).

## 10. Slack Outage / Degradation
Symptoms: Slack API timeouts, high rate of retries, missing updates.
Mitigations:
- Enable update queue (`SLACK_UPDATE_QUEUE=true`) to coalesce updates.
- Rate limit metrics? (Future enhancement) Monitor logs for 429 entries.
- Fallback: Requests continue accumulating; approval UX blocked. Communicate incident; optionally add admin override endpoint (future).

## 11. Retention & Archival Operations
- Purge sweeper removes terminal requests older than retention window; archives JSON lines to `RETENTION_ARCHIVE_DIR`.
- Validate disk usage: ensure archive directory on persistent volume (prod).
- Restore (manual): parse JSONL, ingest into analytics system; no automated rehydrate path (design choice).

## 12. Backup & Restore
Currently limited to archive files + optional Redis snapshots (RDB/AOF). For compliance, schedule object store sync of archival directory + enable Redis persistence.

## 13. On-Call Alert Response
Recommended alerts:
| Alert | Condition | Initial Triage |
|-------|-----------|---------------|
| High approval latency | p95 `decision_latency_seconds` > SLO for 5m | Check Slack API health, Redis latency |
| Escalation surge | `escalations_total` rate spike | Inspect pending requests count; policy misconfig? |
| Error spikes | 5xx rate > threshold | Check logs for stack traces, memory pressure |
| Replay/security anomalies | `security_events_total` abnormal increment | Validate signature timestamps & replay cache health |
| Retention failures | `request_archive_failures_total` > 0 | Check disk permissions & space |

## 14. Metrics & Dashboards
Core panels:
- Requests Created / Approved / Denied / Expired (rate)
- Decision Latency (P50, P95, P99) split by outcome
- Pending Requests & Oldest Age
- Persona Pending gauge breakdown
- Override outcomes & rejection reasons
- Escalations over time
- Retention purge / archive counts
- Slack update queue (future) backlog size

## 15. Troubleshooting Playbooks
| Issue | Steps |
|-------|-------|
| Requests stuck awaiting personas | Confirm persona state via `GET /api/guard/wait?token=...`; verify Slack ack interactions arriving; check policy persona list |
| Approvals not reflected | Check Redis connectivity, audit log for errors, ensure no duplicate approver issue |
| High memory usage | Capture heap snapshot (Node inspector) off-peak; look for retained request objects beyond retention window |
| Policy reload not applying | Verify `policy_reloaded` audit event; ensure correct `POLICY_PATH`; check container volume mount |
| Tracing absent | Confirm `TRACING_ENABLED=true`; if OTLP exporter verify endpoint + headers reachable |

## 16. Capacity Planning
Baseline (from load harness): low ms create & decision times in-memory. For multi-tenant scale:
- Redis CPU & memory sized for key cardinality (#requests + approvals + persona states) * retention window.
- Horizontal scaling requires Redis; memory backend not shareable.
- SSE connections: budget file descriptors (e.g., 50-200). Use keepalive and consider connection limits.

## 17. Hardening Roadmap (Forward Look)
- Add multi-arch image builds (arm64)
- Distroless runtime stage (remove shell/toolchain)
- Cosign signatures & SBOM generation
- Structured logging fields for correlation IDs
- Slack API 429 metrics & circuit breaker
- Distributed replay/rate limiter (future item #29)

## 18. Change Management
Patch releases: tag `vX.Y.Z` triggering `release.yml`. Maintain CHANGELOG (to be added) + dependency review.

## 19. Contacts / Escalation
- Primary: On-call engineer (PagerDuty rotation: Approval-Guard)
- Secondary: Platform SRE
- Slack Channel: #approval-guard-ops
- Email: platform-sre@example.com

---
Append improvements via PR; keep timestamps accurate.
