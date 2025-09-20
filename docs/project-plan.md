# Approval Service Project Plan

Status: Draft  
Last Updated: 2025-09-20 (completed items 37,39,40,41; retention & archival added)

## 1. Overview
This plan tracks remaining work to take the Approval Service from scaffolding to a production-ready, secure, observable, and operable system.

## 2. Phased Roadmap (Suggested Order)
1. Core Hardening (Auth + Approvals) – Items 1–3, 8
2. Persistence & Lifecycle – Items 4–6
3. Experience & Delivery – Items 7, 9
4. Observability & Compliance – Items 10–13
5. Deployment & Operations – Items 14–17
6. Documentation & Polish – Item 18

## 3. Backlog (Work Items)
| ID | Title | Description | Depends On | Phase | Exit Criteria | Complete |
|----|-------|-------------|------------|-------|---------------|----------|
| 1 | Enforce approver allowlists | Only allow listed Slack IDs / superApprovers to approve/deny; persist approver IDs | — | 1 | Unauthorized user attempt rejected & logged | ✅ |
| 2 | Distinct multi-approval tracking | Track unique approvers; prevent duplicates; expose approvers array | 1 | 1 | `wait` response shows unique list; duplicates ignored | ✅ |
| 3 | Persona acknowledgment interactions | Add checklist & gating; disable Approve until all personas ack | 1 | 1 | Approve button disabled until personas ack state reached | ✅ |
| 4 | Redis persistence adapter | Replace in-memory store; TTL for pending; env `REDIS_URL` | 1 | 2 | All CRUD via Redis; restart doesn’t lose active requests | ✅ |
| 5 | Timeout & escalation scheduler | Expire requests & fire single escalation notice (`escalateBeforeSec`); threaded Slack warning & dynamic remaining time | 4 | 2 | Escalation logged once then expiration transitions request | ✅ |
| 6 | Re-request lineage & rate limiting | `lineage_id` + cooldown & per-lineage limits | 4 | 2 | Re-request button creates new request with lineage chain | ✅ |
| 7 | SSE streaming endpoint | Real-time state push; heartbeat; polling fallback | 1 | 3 | Open connection receives state transitions instantly | ✅ |
| 8 | Security hardening | Slack timestamp skew, replay guard, rate limits, mTLS option | 1 | 1 | All security tests pass; stale signatures rejected | ✅ |
| 9 | Parameter override modal | Slack modal for Approve with edits; validate & merge | 2 | 3 | Edited params reflected in final decision payload | ✅ |
|10 | Audit log persistence backend | Durable sink (file/Redis Stream); export tool | 4 | 4 | `audit export` returns filtered events | ✅ |
|11 | Metrics & tracing | /metrics endpoint + OTEL spans | 4 | 4 | Prometheus scrape + minimal trace spans visible | ✅ |
|12 | Expanded test suite | Integration, persona, timeout, replay, Redis tests | 4,5 | 4 | >85% critical path coverage; CI green | ✅ |
|13 | Load & concurrency test | High-volume simulation; latency percentiles | 11 | 4 | Documented P50/P95 latency + no race issues |  |
|14 | Deployment & packaging | Dockerfile, k8s manifests, env validation | 4 | 5 | Image published & manifests deploy locally |  |
|15 | CI/CD pipeline setup | GH Actions: lint, test, build, scan, tag release | 14 | 5 | Automated build+publish on tag push |  |
|16 | Operational runbook | Secret rotation, failover, escalation tuning, on-call | 10,11 | 5 | Runbook reviewed & versioned |  |
|17 | Production readiness checklist | Security & DR signoff, backups, thresholds | 16 | 5 | Checklist completed & signed |  |
|18 | Documentation polish & examples | SSE usage, persona flow, lineage examples | 7,6 | 6 | Updated docs + examples merged |  |
|19 | Metrics endpoint exposure | Implement `/metrics` (Prometheus text) exporting counters; add decision latency histogram skeleton | 11 | 4 | /metrics returns 200 with counters | ✅ |
|20 | Approval latency histogram | Measure create→terminal duration; bucket & expose (now labeled with outcome) | 11 | 4 | Histogram shows non-zero observations | ✅ |
|21 | Per-action escalation metrics | Tag counters by action & escalation state | 11 | 4 | Escalations labeled per action | ✅ |
|22 | Slack rate limit backoff | Queue & retry Slack API calls with exponential backoff + jitter | 8 | 4 | No dropped messages under simulated 429 |  |
|23 | Add outcome label to latency histogram | Record decision_latency_seconds per action & outcome (approved/denied/expired) | 11,19 | 4 | Histogram entries include outcome label | ✅ |
|24 | Persona acknowledgment metrics | Counters & gauges for persona ack progress | 3 | 4 | persona_ack_total & persona_pending gauge present | ✅ |
|25 | Live in-progress duration gauge | Track avg & max age for open requests per action | 11,19 | 4 | oldest_open_request_age_seconds & avg age metrics exposed | ✅ |
|26 | Tracing spans (OTEL) | Add minimal spans around request lifecycle & Slack calls | 11 | 4 | Trace viewer shows end-to-end spans | ✅ |
|27 | Parameter override metrics | Counter param_overrides_total{action,outcome} (applied/rejected) | 9 | 4 | Metric increments on successful override submission / rejection labeled | ✅ |
|37 | Trace span assertion tests | Add tests ensuring critical spans emitted (create, approve, expire, escalate, slack.post/update) | 26 | 4 | Tests fail if span names missing | ✅ |
|38 | OTLP trace exporter option | Env toggle to export spans to OTLP endpoint (OTLP_ENDPOINT, OTLP_HEADERS, OTLP_TIMEOUT_MS) | 11,26 | 4 | Spans visible in external collector when configured | ✅ |
|39 | Slack rate limit queue v2 | Coalesce rapid consecutive message updates & jitter backoff (with debounce) | 22 | 4 | Reduced duplicate updates under churn | ✅ |
|40 | Policy hot-reload | Reload policies from disk/Redis on SIGHUP or admin endpoint | 10 | 4 | Policy changes applied without restart | ✅ |
|41 | Retention & archival policy | TTL + archival export for audit + requests | 10 | 4 | Documented retention config & automated purge | ✅ |
|28 | Metrics reference documentation | Dedicated docs/metrics.md detailing each metric & labels | 11,19,23,24,25 | 4 | File published & linked from README | ✅ |
|29 | Distributed replay/rate limit cache | Redis-backed replay + rate limit synchronization | 4,8 | 4 | Replay & rate limits function across multi-instance |  |
|30 | Override governance policy | Enforce allowed override keys + optional diff size limit | 9 | 3 | Attempts exceeding limits rejected & audited | ✅ |
|31 | Override schema validation | Per-action lightweight JSON schema for overrides | 9 | 3 | Invalid overrides rejected & audited | ✅ |
|32 | Override diff size limit | Reject based on combined changed value length | 30 | 3 | Rejections audited with reason diff_size_exceeded | ✅ |
|33 | Custom schema error messages | Allow per-property errorMessage override | 31 | 3 | Custom message appears in rejection audit & Slack error | ✅ |
|34 | Override rejection counters | Add counters per rejection reason (limit/schema/diff) | 30,31,32 | 4 | /metrics exposes override_rejections_total{action,reason} | ✅ |
|35 | Schema introspection endpoint | Expose GET /api/schemas/:action redacted view | 31 | 3 | Endpoint returns loaded schema subset | ✅ |
|36 | Override outcome labeling | Add outcome label to param_overrides_total (applied/rejected) | 27,30-32 | 4 | Metric exposes outcome label | ✅ |

## 4. Detailed Work Item Notes
### Item 1 – Enforce approver allowlists
Add runtime guard in interaction handler; ephemeral rejection for non-authorized; audit event `unauthorized_attempt`.

### Item 3 – Persona Interactions
Render dynamic checkbox block; each ack triggers state evaluation; only when all = ack, enable Approve buttons (or add them). Optionally show partial progress.

### Item 5 – Timeout & Escalation
Scheduler interval default: 5000ms (overridable via `SCHEDULER_INTERVAL_MS`). Each request stores `expires_at` and optional `escalate_at = expires_at - escalateBeforeSec`. When current time >= `escalate_at` (and < `expires_at`) a single threaded Slack escalation notice posts (`request_escalated` audit). When current time >= `expires_at` non-terminal requests become `expired` (`request_expired` audit) and message updates (buttons disabled). Tests cover both escalation and expiration timing.

### Item 7 – SSE Endpoint
URL: `GET /api/guard/wait-sse?token=...`. Events: `state`, `heartbeat`. Close connection on terminal states.

### Item 8 – Security Hardening
* Reject if `abs(now - slack_timestamp) > 300s`.
* Store signature hash in Redis TTL set (5m) to block replay.
* Global rate limit (token bucket) per IP for `/api/guard/request`.
* Optional mTLS: env `REQUIRE_CLIENT_CERT=true` + Node HTTPS server config.

### Item 9 – Parameter Override Modal
Slack `views.open` on `approve_with_edits` button; JSON form limited to allowlist keys; validate via action schema registry (future `schemas/<action>.json`).

### Item 10 – Audit Backend
Strategy: Redis Stream `audit:events` (XADD) or append-only NDJSON file. Provide CLI export filter by time window + action + status.

### Item 11 – Metrics
Counters: `approval_requests_total{action}`, `approvals_total`, `denies_total`, `expired_total`, `escalations_total`.
Histogram: `decision_latency_seconds` (record on terminal state). Gauge: `pending_requests`.

### Item 12 – Test Suite Expansion
Use Vitest + local Redis (test container). Mock Slack Web API via nock or internal stub.

### Item 13 – Load Test
Simple Node script or k6 scenario: 200 concurrent requests; random approve latency; measure decision time distribution.

### Item 14 – Deployment Packaging
Dockerfile multi-stage (`node:20-alpine` build → distroless runtime). Add health (`/healthz`) & readiness (`/readyz`) endpoints.

### Item 15 – CI/CD
Jobs: `lint`, `typecheck`, `unit`, `integration-redis`, `build-image`, `scan` (trivy), `publish` (on tag). Cache node_modules with hash of lockfile.

### Item 16 – Runbook Sections
1. Secrets rotation steps.
2. Policy reload procedure.
3. Redis failover verification.
4. Approval latency SLO investigation.
5. Slack outage / degraded mode (queue requests; poll fallback).

### Item 17 – Production Readiness Checklist
* Security review signoff
* All high severity vulnerabilities resolved
* Load test results documented
* Backup policy for audit logs validated
* On-call runbook approved
* Metrics dashboard published
* DR scenario (Redis restore) executed

### Item 18 – Documentation Polish
Add: persona sequence diagram, SSE client snippet (curl + Node), lineage ASCII diagram, policy cookbook (examples: single approver, 2-of-3 quorum, persona gating + escalation).

## 5. Acceptance Criteria (Roll-Up)
| Category | Criteria |
|----------|----------|
| Authorization | Only allowlisted users (or superApprovers) can approve/deny; attempts by others audited. |
| Personas | Requests requiring personas cannot be approved prematurely; Slack UI reflects progress. |
| Reliability | Requests expire exactly at timeout (± <5s drift) and escalation fires once. |
| Observability | Metrics endpoint exposes counters & histograms; traces show end-to-end span. |
| Security | Slack replay blocked; timestamp skew enforced; approvals idempotent. |
| Data Integrity | Audit log includes `policy_hash`, `payload_hash`, `decision`, `approvers[]`. |
| Performance | P95 approval decision latency (non-waiting time) < 250ms internal processing. |
| Load | System sustains 200 concurrent pending requests & 50 SSE streams without degradation. |

## 6. Risks & Mitigations
| Risk | Impact | Mitigation |
|------|--------|-----------|
| Redis outage | Approvals stall | Implement transient in-memory buffer + circuit breaker |
| Slack rate limits | Delayed notifications | Exponential backoff + queue + metrics alert |
| Replay attack | Unauthorized state change | Signature replay cache + strict timestamp |
| Policy misconfig | Unintended denies or open approvals | Policy validation + dry-run mode + policy hash tagging |
| SSE scaling | Excess open FDs | Connection cap + fallback polling + keepalive timeouts |

## 7. Metrics Definition
Prometheus naming convention: snake_case, base unit seconds where temporal.
| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| approval_requests_total | counter | action | Number of guard requests created |
| approvals_total | counter | action | Count of approvals (final) |
| denies_total | counter | action | Count of denies |
| expired_total | counter | action | Count of expired requests |
| escalations_total | counter | action | Escalation notifications sent |
| decision_latency_seconds | histogram | action, outcome | Time from request create → terminal state (labeled by terminal outcome) |
| pending_requests | gauge | action | Current non-terminal requests |
| param_overrides_total | counter | action, outcome | Override submissions by outcome (applied/rejected) |
| override_rejections_total | counter | action, reason | Override rejection reasons (limit_exceeded, diff_size_exceeded, schema_validation) |

## 8. Environments
| Env | Purpose | Differences |
|-----|---------|------------|
| dev | Local iteration | In-memory store optional; verbose logging |
| staging | Pre-prod validation | Full Redis + Slack test workspace |
| prod | Production | Hardened security, mTLS optional, metrics & tracing on |

## 9. Exit / Launch Checklist
1. All backlog items status = Done (or consciously deferred + documented).
2. Security hardening tasks completed & validated by test harness.
3. Load & concurrency test results documented in repo.
4. Runbook accessible & reviewed.
5. Observability dashboard live & linked in README.
6. CI pipeline green across 3 successive runs.
7. Version tag created (v1.0.0) with changelog.

## 10. Tracking & Reporting
Recommend mapping each ID to an issue (e.g., GitHub issues with label `approval-svc`) and a project board with columns: Backlog → In Progress → Review → Done.

---
Prepared as implementation guide & execution tracker. Update `Last Updated` field when modifying plan.
