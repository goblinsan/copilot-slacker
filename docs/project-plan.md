<small>Rewritten for clarity & MVP focus. Previous large tabular backlog compressed into prioritized tiers.</small>

# Approval Service Project Plan

Status: MVP Convergence (Post-M1–M4 Complete)
Last Updated: 2025-09-21 (after escalation test hardening & smoke metrics assertions; latency baseline captured)

---
## 1. Purpose
Define the minimal, stable, internally usable Approval Service (MVP) and the shortest path to reach and maintain it, while clearly separating fast-follower and deferred scope.

---
## 2. Current Functional State (Snapshot)
Implemented & validated:
- Request lifecycle: create → (optional personas) → approve / deny / expire (with escalation) ✅
- Policy engine: per-action allowlists, min approvals, personas, timeout, escalation config ✅
- Security: Slack signature verify (HMAC), timestamp skew (<300s) (VERIFY/CONFIRM), replay guard (VERIFY), allowlist enforcement ✅
- Re-request lineage: cooldown + simple rate limiting ✅
- Overrides: schema validation, governance limits, metrics, audit ✅
- Metrics: counters (requests, approvals, denies, expired, escalations, overrides, overrides_rejections, personas), decision latency histogram (action,outcome), gauges for open + oldest age ✅
- SSE: state streaming + heartbeat + terminal close; test stabilized ✅
- Scheduler: deterministic expiration + escalation timing ✅
- Smoke: approve, deny, expire (with escalation) + metric delta validation ✅
- Tracing: baseline spans + optional OTLP ✅
- Docs: TESTING.md, policies, runbook (baseline) ✅

Remaining Verification Focus:
- Consecutive green CI runs target (≥5) including SSE stream stability.
- Optional SSE multi-run flake guard (M5) – decide before tag.

---
## 3. MVP Definition (Strict Scope)
An internal pilot-ready service delivering: secure approval gating, observable metrics, deterministic terminal outcomes (approve/deny/expire), and policy-driven governance—without requiring horizontal scale or durability beyond current in-memory (explicitly documented) OR with Redis if already integrated.

### MVP Acceptance Criteria
| Domain | Criteria |
|--------|---------|
| Security | Valid signature + skew + replay protection enforced; unauthorized approver attempts audited. |
| Lifecycle | Escalation fires once before expiry; expiry transitions within +/−5s of timeout. |
| Approvals | Unique approver identities; duplicate suppressed; min approvals respected. |
| Personas (Decision) | Personas optionally DEFERRED for MVP (decision: see §7). If enabled: gating correct; if deferred: documented limitation. |
| Observability | Metrics counters & latency histogram present after smoke run; escalation & expired counters increase appropriately. |
| Streaming | SSE emits ≥1 non-terminal state and closes on terminal; fallback polling works. |
| Smoke Validation | Single command validates approve, deny, expire + metrics deltas (and escalation). |
| Docs | Quickstart (run locally + run smoke) <10 mins; policy authoring guide; limitations section. |
| Tracing | At least request create → terminal span chain present. |
| Reliability | Five consecutive green test runs (including SSE) in CI. |

### Explicit MVP Non-Goals
- Horizontal scaling / distributed replay cache.
- Advanced Slack rate limit adaptive queueing.
- Signed container images & provenance enforcement (foundation exists but optional).
- Incident process templates & HA failover drills.

---
## 4. Immediate MVP Closure Tasks (High Impact / Low Effort)
| # | Task | Type | Effort | Status |
|---|------|------|--------|--------|
| M1 | Add escalation counter assertion to smoke (expire scenario) | Test Hardening | XS | Done |
| M2 | Confirm timestamp skew & replay tests (stale + replay) | Security Test | S | Done |
| M3 | README Quickstart + Limitations + Slack setup snippet | Docs | S | Done |
| M4 | Latency baseline capture (approve path) & record | Perf Baseline | XS | Done |
| M5 | SSE multi-run (5x) reliability check (optional gate) | Stability | XS | Pending |
| M6 | Persona scope decision (Enable minimal flow) | Product Decision | XS | Done |

Completion of M1–M4 (and decision for M6) declares MVP; M5 optional but recommended.

---
## 5. Fast-Follower (Post-MVP, Near-Term)
| ID | Item | Rationale |
|----|------|-----------|
| F1 | Slack rate limit backoff & metrics (former backlog #22/#49) | Prevent notification gaps under spike |
| F2 | Distributed replay & rate limit cache (former #29) | Multi-instance readiness |
| F3 | Image signing (former #45) | Supply chain integrity |
| F4 | Weekly vulnerability scan workflow (former #46) | Continuous security posture |
| F5 | Dependency automation (former #47) | Reduce drift & vuln window |
| F6 | Redis HA / failover test (former #48) | Reliability maturity |
| F7 | Incident timeline template (former #50) | Faster postmortems |

---
## 6. Deferred / Documented Limitations
- No guaranteed durability without Redis (if running in-memory mode). Restart loses active requests.
- No adaptive Slack 429 handling (may log `not_authed` or 429 errors; approvals still functional logically).
- Single escalation notice; no re-escalation schedule.
- No multi-region failover or DR automation beyond documented manual procedures.
- Persona revocation (un-ack) and advanced persona policies (role-based persona groups) not implemented.

---
## 7. Persona Flow Decision
Decision: ENABLE minimal persona gating for MVP.

Rationale: Provides early validation of multi-stage gating without adding revocation complexity. Persona acks required before enabling Approve buttons; smoke script treats `awaiting_personas` create result as a soft pass for base path while dedicated persona tests exercise full flow.

Future Enhancements:
* Persona revocation / re-request
* Persona group aliasing / dynamic policy-driven persona sets
* Metrics: persona ack latency histogram

---
## 8. Latency Baseline (Captured via M4)
Load harness run (in-memory store, local dev laptop, Node 20, no Slack network I/O):

Run parameters:
```
requests=80 concurrency=40 approve=true
RATE_LIMIT_CAPACITY=1000 RATE_LIMIT_REFILL_PER_SEC=100
```
Percentiles (ms):
```
Request create HTTP  : P50 ≈ 41.8ms  P95 ≈ 68.6ms  P99 ≈ 69.6ms (count=80)
Approval op (in-proc): P50 ≈ 0.28ms  P95 ≈ 0.50ms  P99 ≈ 1.47ms (count=80)
End-to-end (create→approved): P50 ≈ 70.6ms  P95 ≈ 116.0ms  P99 ≈ 117.2ms (count=80)
```
Interpretation:
- Processing headroom: P95 internal approval work < 1ms -> majority of latency is request creation + scheduling overhead.
- End-to-end P95 < 120ms comfortably under provisional 250ms P95 target (internal processing threshold).
- No 429 rate limit errors under raised capacity; earlier baseline showed rate limiting skewing create latency distribution.

Notes:
- Expire path latency not measured in this run (requires timeout scenario). For MVP we treat approve path as primary SLO; expire timing already validated via scheduler tests (±<5s drift). A future load harness extension will add synthetic expirations for distribution capture.

Collection Method: `npm run load-sim -- --requests 80 --concurrency 40 --approve true` with elevated rate limit env to avoid artificial 429s.

---
## 9. Operational Run Quickstart (Draft)
1. `npm ci && npm run build`
2. `SLACK_SIGNING_SECRET=test_secret PORT=8080 node dist/src/server.js`
3. Run smoke: `npx ts-node scripts/smoke.ts --scenarios=approve,deny,expire`
4. Metrics: `curl :8080/metrics | grep approval_requests_total`
5. SSE (manual): `curl -N 'http://localhost:8080/api/guard/wait-sse?token=...'`

---
## 10. MVP Exit Checklist
| Item | Verified |
|------|----------|
| Smoke approve/deny/expire + escalation assertion passing | ☑ |
| Replay + timestamp skew tests green | ☑ |
| README Quickstart + Limitations merged | ☑ |
| Latency baseline captured in plan | ☑ |
| Five consecutive green CI runs (includes SSE) | ☐ |
| Persona decision documented (enable) | ☑ |
| Tag `v0.9.0-mvp` created | ☐ |

---
## 11. Metrics (Reference)
Key counters & histogram already exposed (see metrics documentation). Smoke validation ensures deltas for: approvals, denies, expired, escalations, requests, latency histogram presence.

---
## 12. Next Actions (Execution Order)
1. Implement M1 (smoke escalation assertion)
2. Implement M2 (security tests) – confirm existing first
3. Implement M3 (README Quickstart)
4. Capture M4 (latency) & update plan
5. Decision M6 (personas)
6. (Optional) M5 SSE multi-run guard

---
## 13. Changelog Note
On MVP declaration create annotated tag with summary of implemented domains and explicit limitations.

---
## 14. Appendix: Historical Scope (Legacy Backlog)
The pre-rewrite expansive backlog (IDs 1–50) has been triaged. Items not surfaced in sections 4–6 are implicitly deferred beyond fast-follower horizon.

---
End of Plan

## 4. Detailed Work Item Notes
### Item 14 – Deployment Packaging (Completed)
Implemented multi-stage Dockerfile (node:20-alpine) producing minimal runtime image, added `.dockerignore`, centralized `config.ts` for env validation (production requires Slack secrets), and JSON `/readyz` endpoint (policy + store). README updated with Docker usage, K8s manifest including probes, and operational considerations. Next steps (future items): CI image publish, security scanning, distroless or slim runtime evaluation, and multi-arch builds.

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
Implemented `scripts/load-sim.ts` (Node + tsx). Provides concurrent request creation and inline approvals; reports create / approval op / end-to-end percentiles. Baseline local dev (30 req / 5 concurrency, in-memory, no Slack post): create P50≈4ms P95≈8ms, approval op P50<0.2ms, end-to-end P95≈9ms. Future enhancements: denial & timeout scenarios, Slack API latency simulation, CSV export, ramp profiles.

### Item 14 – Deployment Packaging (Note)
Earlier duplicate note removed; authoritative description exists in completed section above. Distroless migration tracked under future item #43.

### Item 15 – CI/CD (Completed)
Implemented GitHub Actions:
* `ci.yml` on push/PR: steps (checkout, Node 20 setup, `npm ci`, lint, `typecheck`, Redis-backed test run, build dist, Docker build, dual Trivy scans fs+image with non-blocking exit).
* `release.yml` on tag `v*`: build dist, Docker metadata, GHCR login via `GITHUB_TOKEN`, build & push image with both `latest` and semantic tag, post-push Trivy scan.
Caching: `actions/setup-node` npm cache. Future enhancements: provenance attestations (SLSA), dependency review gating, multi-arch manifest (`linux/amd64, linux/arm64`), weekly vulnerability re-scan job.

### Item 16 – Operational Runbook (Completed)
Created `docs/runbook.md` covering: system overview, secrets rotation, policy reload mechanisms, Redis failover diagnostics, escalation & timeout tuning, latency SLO investigation methodology, Slack outage mitigations, retention & archival operations, backup & restore guidance, on-call alert catalog with triage steps, metrics dashboard recommendations, troubleshooting playbooks, capacity planning, forward hardening roadmap (multi-arch, distroless, cosign, rate limit metrics), change management, and contacts. Future enhancements: add live incident timeline template, per-metric SLO doc, and automation scripts for common diagnostics.

### Item 17 – Production Readiness Checklist (Completed)
Created `docs/production-readiness.md` summarizing: SLOs (latency, availability), security controls (signature verification, replay defense, mTLS option), DR plan (Redis snapshot + archive export), backup validation steps, escalation & paging policy, performance baseline (load harness data), metrics dashboard inventory, and go-live gates (all critical items closed, no HIGH vulns, runbook approved, restore test passed).

### Item 42 – Multi-arch Image Build (Completed)
Updated `release.yml` to enable `docker/setup-qemu-action` and `docker/setup-buildx-action` then build & push a manifest list for `linux/amd64,linux/arm64` via `docker/build-push-action@v5` with cache configuration. Provenance & SBOM generation intentionally disabled for now (tracked under items #44 and #44/#45). Exit criteria met: future tag releases will publish multi-architecture images (`latest` + semantic tag) to GHCR.

### Item 43 – Distroless Runtime Image (Completed)
Refactored Dockerfile to use Debian slim build + production dependency stages and a `gcr.io/distroless/nodejs20-debian12:nonroot` final runtime. Added optional `debug` target (alpine) for troubleshooting. Benefits: reduced attack surface (no shell/package manager), non-root base, likely lower vulnerability footprint vs Alpine/musl glibc mismatch. Caveats: requires all native modules built in build stage; no shell inside container for live debugging (use debug target or ephemeral sidecar). Sets explicit ENTRYPOINT with absolute Node path.

### Item 44 – SBOM & Provenance (Completed)
Enhanced `release.yml` to generate a CycloneDX SBOM (anchore/sbom-action) for the pushed multi-arch image and produce an in-toto SLSA provenance attestation (slsa-framework generator). Added `id-token: write` permission for OIDC signing. Captured final image digest via `docker buildx imagetools inspect` and published both SBOM and provenance as workflow artifacts (`sbom-<tag>.cdx.json`, `provenance-<tag>.intoto.jsonl`). These artifacts establish supply chain transparency foundations prior to image signing (item #45). Future improvement: attach SBOM/provenance directly to GitHub Release assets and optionally store SBOM in OCI registry (`oci:application/vnd.cyclonedx+json`).

### Future Enhancements Backlog
Outlined items 42–50 targeting operational hardening: multi-architecture distribution, distroless runtime to shrink attack surface, supply chain integrity (SBOM, provenance, signing), continuous vulnerability posture (scheduled scans & dependency automation), resilience (Redis HA test), observability gap closure (Slack 429 metrics), and incident process maturity (timeline template).

### Newly Identified Refinement Candidates (Post #37 CI Hardening)
| Ref | Title | Description | Rationale |
|-----|-------|-------------|-----------|
| R1 | Deterministic scheduler unit tests | Add pure function tests for escalation/expiration decision logic (bypassing store) | Further reduce regression surface & speed feedback |
| R2 | Unified test status polling helper | Replace ad-hoc `waitFor` patterns with a shared `waitForStatus(token,status)` | Consistency & less timing fragility |
| R3 | Approval helper abstraction | Add `approveRequest(port, id, userId?)` with signature generation | Reduce boilerplate in security & SSE tests |
| R4 | Test documentation (`TESTING.md`) | Document deterministic hooks: `__TEST_runSchedulerAt`, retention sweep, direct approval path | Contributor onboarding & consistency |
| R5 | Slack simulation mode | Provide an in-memory Slack client shim to emit spans/metrics without real API | More predictable tests without network mocking |
| R6 | Metrics shape verification tests | Golden file snapshot of `/metrics` for a seeded scenario | Catch unintended metric label/value regressions |
| R7 | Policy schema validation CLI | `npm run policy:validate` to preflight changes locally/CI | Prevent misconfig deploys |
| R8 | Structured changelog generation | Automate release notes from merged PR conventional commits | Faster iteration & release hygiene |
| R9 | mTLS integration test | End-to-end test hitting HTTPS server with client cert | Validate optional security path before prod enable |
| R10 | Load harness scenario expansion | Add denial + timeout + persona ack mix & Slack latency simulation | Closer to production behavior under stress |

### Deferred / To Re-Evaluate
| Item | Reason for Deferral | Revisit Criteria |
|------|--------------------|------------------|
| 29 (Distributed replay/rate limit cache) | Single-instance acceptable for current scale | When horizontal scaling planned |
| 45 (Image signing) | SBOM & provenance prioritized first | Security review window or pre GA |
| 46 (Weekly vuln re-scan) | Manual scans sufficient short-term | After first external pilot |
| 47 (Dependency automation) | Low churn dependencies presently | Growing dependency graph / monthly drift |
| 48 (Redis HA / failover test) | Early stage, single node ok | Staging cluster readiness |
| 49 (Slack 429 metrics & alerts) | Basic queue covers immediate need | Observed sustained 429 bursts |
| 50 (Incident timeline template) | Runbook baseline established | First real incident / chaos exercise |

## 11. MVP Definition & Current Status
MVP Intent: Provide a reliable internal approval workflow (create → gated → approve/deny/expire) with core security, persistence, observability, and deterministic lifecycle guarantees—sufficient for limited internal adoption and feedback before GA hardening.

MVP Must-Haves (All Implemented Unless Noted):
| Area | Requirement | Status | Notes |
|------|-------------|--------|-------|
| Auth & Allowlist | Enforce approver allowlists + superApprover bypass | ✅ | Audited unauthorized attempts |
| Personas | Persona gating blocks early approval | ✅ | Checklist flow active |
| Multi-Approver Integrity | Unique approvers, no duplicates | ✅ | Reflected in wait / SSE state |
| Persistence | Redis adapter with TTL cleanup | ✅ | Restart resilience in place |
| Lifecycle Timing | Escalation + expiration (single escalation) | ✅ | Deterministic test passing |
| Streaming | SSE endpoint streams state + closes on terminal | ⚠️ | Test flakiness under investigation (R11) |
| Security | Signature verify + replay defense + timestamp skew | ✅ | <300s skew enforced |
| Overrides | Modal + governance + schema validation | ✅ | Metrics & audit emitted |
| Observability (Core) | Metrics counters + decision latency histogram | ✅ | Outcome/action labels present |
| Tracing | Minimal lifecycle spans + optional OTLP export | ✅ | Baseline spans present |
| Smoke Validation | Approve scenario automated | ✅ | Deny/expire variants planned |
| Tests | Scheduler deterministic + core integration | ✅ | SSE reliability enhancement pending |
| Docs | Quickstart, personas, overrides, SSE, lineage | ✅ | MVP section added |

Outstanding for MVP Declaration:
1. R11: Stabilize SSE test (instrumentation + helper refactor) – ensure ≥5 consecutive green runs.
2. Extend smoke script to include deny + expire scenarios (serial), assert metrics increments.
3. Metrics sanity test: confirm histogram line & counters appear after scripted flow.
4. Add lightweight SSE client code sample (if not already embedded) for internal integrators.
5. Record latency baseline (P50/P95) from load sim in this section.

Post-MVP Priority (Early Hardening):
1. Item 22 – Slack rate limit backoff & retry metrics.
2. Choose between Item 29 (distributed replay/rate limit) vs Item 45 (image signing) based on adoption trajectory.
3. Item 49 – Slack 429 metrics & alert thresholds.
4. Item 50 – Incident timeline template.

Refinement Items (Active / New):
| Ref | Title | Purpose | Status |
|-----|-------|---------|--------|
| R2 | Unified test status polling helper | Reduce timing flakes | Planned |
| R3 | Approval helper abstraction | Standardize request approval in tests | Planned |
| R4 | TESTING.md (added) | Document deterministic hooks | ✅ |
| R11 | SSE reliability & instrumentation | Eliminate flake, add `SSE_DEBUG` logging | In Progress |

Latency Baseline Placeholder:
```
To be captured post SSE stabilization:
create->approve P50: TBD ms, P95: TBD ms
create->expire P50: TBD ms, P95: TBD ms
```

Smoke Scenarios Coverage Plan:
| Scenario | Path | Expected Metrics Delta |
|----------|------|------------------------|
| Approve | create → approve | approval_requests_total +1; approvals_total +1; decision_latency_seconds +1 obs |
| Deny | create → deny | approval_requests_total +1; denies_total +1; histogram +1 obs (outcome=denied) |
| Expire | create → wait → expire | approval_requests_total +1; expired_total +1; histogram +1 obs (outcome=expired); escalations_total maybe +1 if escalateBeforeSec set |

MVP Exit Gate: All Outstanding items above resolved + latency baseline captured + annotated tag (e.g. `v0.9.0-mvp`) created.


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
