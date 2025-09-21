# Approval Service (Slack Guard)

Slack-based approval gate for LLM / agent risky operations (dependency install, migrations, config changes, etc.).

## Features
* Guarded action requests with policy-driven routing and timeouts.
* Slack interactive Approve / Deny buttons.
* Optional parameter override modal (policy-gated safe edits prior to approval).
* Override governance (limit changed keys, audited diffs & rejections).
* Override diff size limit (`OVERRIDE_MAX_CHARS`) and custom schema error messages.
* Persona co-sign (scaffolding present; enrichment TBD).
* Audit logging (stdout JSON lines).
* Pluggable store (in-memory; replace with Redis adapter).

## Quickstart
Fast path to a local approval loop (minimal, in-memory). For a fuller walkthrough (including simulated signed Slack interaction) see `docs/quickstart.md`.

1. Install deps:
```bash
npm install
```
2. Start dev server (pilot mode suppresses certain production validations):
```bash
PILOT_MODE=true SLACK_SIGNING_SECRET=test_secret SLACK_BOT_TOKEN=xoxb-test npm run dev
```
   Server listens on `:8080` (set `PORT` to change). Policy file defaults to `.agent/policies/guards.yml`.
3. Create a demo request:
```bash
curl -s -X POST localhost:8080/api/guard/request \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "demo",
    "params": {"ref":"main"},
    "meta": {"origin":{"repo":"org/repo"}, "requester":{"id":"U1","source":"slack"}, "justification":"deploy"}
  }' | tee /tmp/req.json
```
4. Extract token & wait (polling):
```bash
TOKEN=$(jq -r '.token' /tmp/req.json)
curl -s "localhost:8080/api/guard/wait?token=$TOKEN"
```
5. (Optional) Stream via SSE in another terminal:
```bash
curl -N "localhost:8080/api/guard/wait-sse?token=$TOKEN"
```
6. Simulate an approval (signed Slack interaction) – full command in `docs/quickstart.md` (§7). After approval the SSE stream closes.
7. Run smoke scenarios (approve, deny, expire) and assert metrics deltas:
```bash
npx ts-node scripts/smoke.ts --scenarios=approve,deny,expire
```
8. View metrics:
```bash
curl -s localhost:8080/metrics | grep approval_requests_total
```
Next: integrate with your agent by POSTing `/api/guard/request` then polling `/api/guard/wait` (or using SSE) until terminal status.

### Slack App Setup
1. Create Slack App (from scratch) → App-Level Tokens (optional if using Web API only).
2. Scopes (Bot): `chat:write`, `commands` (optional), `im:write` (if DM), `users:read` (optional display names).
3. Interactivity: Enable, set Request URL → `https://<ngrok-domain>/api/slack/interactions`.
4. Install app to workspace; invite bot into private channel: `/invite @ApprovalBot`.
5. Copy Bot User OAuth Token → `.env` `SLACK_BOT_TOKEN`.
6. Copy Signing Secret → `.env` `SLACK_SIGNING_SECRET`.

### ngrok
```bash
ngrok http 3000
# update Slack Interactivity URL to https://<random>.ngrok-free.app/api/slack/interactions
```

### Environment Variables (`.env`)
```
PORT=3000
POLICY_PATH=.agent/policies/guards.yml
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
GUARD_BASE_URL=http://localhost:3000
```

### End-to-End Flow
1. Agent POSTs `/api/guard/request`.
2. Service posts Slack message in configured channel.
3. Human clicks Approve → interaction hits service → state updated.
4. Agent polling `/api/guard/wait` receives terminal `approved` status.

### Acceptance Criteria Mapping
| Requirement | Implementation |
|-------------|----------------|
| Slack private channel support | Bot message posting using provided channel; require invite |
| Approve/Deny interactive | `/api/slack/interactions` handler updates state |
| Multi-approver (partial) | Count increments; finalize when meets `minApprovals` (additional persona gating WIP) |
| Audit log | `src/log.ts` writes JSON lines |
| Timeouts | Placeholder fields; scheduler not yet implemented (future) |
| Policies | YAML loaded and evaluated (`policy.ts`) |

### Additional Documentation
* `docs/sse-example.md` – Streaming state changes with SSE.
* `docs/persona-flow.md` – Persona acknowledgement lifecycle.
* `docs/lineage.md` – Re-request (lineage) flow concepts.

## Testing
```bash
npm test
```

## Metrics
The service exposes Prometheus metrics at `GET /metrics` (text format).

Counters (unless noted all labeled by `action`; additional labels indicated):
```
approval_requests_total{action="<action>"}
approvals_total{action="<action>"}
denies_total{action="<action>"}
expired_total{action="<action>"}
escalations_total{action="<action>"}
 security_events_total{type="<bad_signature|stale_signature|replay|rate_limited>"}  # label: type (no action label)
 persona_ack_total{action="<action>",persona="<persona>"}
 param_overrides_total{action="<action>",outcome="applied|rejected"}
```

Histogram (labels: action, outcome where outcome ∈ approved|denied|expired):
```
decision_latency_seconds_bucket{action="<action>",outcome="<outcome>",le="..."}
decision_latency_seconds_sum{action="<action>",outcome="<outcome>"}
decision_latency_seconds_count{action="<action>",outcome="<outcome>"}
```
Represents create→terminal (approve/deny/expire) latency in seconds.

Gauges:
```
pending_requests{action="<action>"}                # Current non-terminal requests
open_requests_status{action="<action>",status="<status>"}  # Per-status open counts (awaiting_personas|ready_for_approval|pending...)
oldest_open_request_age_seconds{action="<action>"} # Age in seconds of the oldest still-open request per action
persona_pending_requests{action="<action>",persona="<persona>"} # Count of requests where persona still pending
```

Example scrape snippet:
```bash
curl -s http://localhost:3000/metrics | grep approval_requests_total
```

Integration (Prometheus `scrape_config` excerpt):
```yaml
scrape_configs:
  - job_name: approval_service
    static_configs:
      - targets: ['approval-service:3000']
```

Dashboards should chart request throughput, decision latency histogram (P50/P95 derived), and escalation frequency per action.

### Baseline Latency (Reference)
Local in-memory baseline (see `docs/project-plan.md` §8): create HTTP P95 ≈ 68ms; approve end-to-end P95 ≈ 116ms (80 req / concurrency 40). Use only as a relative benchmark—production SLOs should incorporate network + Slack latency.

## SSE Streaming (Real-Time Updates)
See `docs/sse-example.md` for details and client patterns.

## Parameter Overrides
When a policy action defines:
```yaml
actions:
  some_action:
    allowParamOverrides: true
    overrideKeys: ["packages", "justification"]
```
the Slack message (once persona gating is satisfied) includes an `Approve w/ Edits` button. Clicking it opens a modal with inputs for each listed key, pre-populated with current redacted values. On submission:

1. Only keys in `overrideKeys` are considered; others ignored even if injected.
2. Changed values merge into `redacted_params` (no exposure of previously redacted secrets).
3. A new `payload_hash` is computed over the merged parameters.
4. The request is approved atomically after applying overrides (single step UX).
5. Governance: if `OVERRIDE_MAX_KEYS` is set, submissions changing more than this number of keys are rejected with an `override_rejected` audit event (reason `limit_exceeded`).
6. Audit event `override_applied` records changed key names and full redacted before/after diff for each changed key.
7. Metric `param_overrides_total{action}` increments on success.
8. Optional schema validation: if a file `.agent/schemas/<action>.json` exists it is loaded and each changed key is validated against a minimal schema subset (type, enum, pattern, minLength, maxLength, min, max). Failures reject the submission with `override_rejected` (reason `schema_validation`). You can supply `errorMessage` per property to replace detailed messages with a single custom one.
9. Diff size governance: if `OVERRIDE_MAX_CHARS` is set, the total length (stringified) of changed values must not exceed it or the submission is rejected (reason `diff_size_exceeded`).

Schema example (`.agent/schemas/deploy_config.json`):
```json
{
  "type": "object",
  "properties": {
    "justification": { "type": "string", "minLength": 10, "maxLength": 140 },
    "version": { "type": "string", "pattern": "^v[0-9]+\.[0-9]+\.[0-9]+$" },
    "retries": { "type": "number", "min": 0, "max": 5 }
  }
}
```
Only changed keys are validated (partial update semantics). Unsupported / extra JSON Schema keywords are ignored.

Planned enhancements (see project plan items 27–30):
* (Done) Schema validation per action (reject malformed values).
* (Done) Governance limits (max keys changed, diff size enforcement).
* (Done) Audit enrichment with before/after diffs (with redaction honored).
* Outcome labeling for override metric if distinct outcomes added.

## Security Notes
* Slack signature verification enforced for `/api/slack/interactions`.
* Timestamp skew check: interactions older/newer than 300s rejected (`stale_signature`).
* Replay protection: identical (timestamp, signature) pair within 5m rejected (`replay_detected`).
* Per-IP rate limiting on `/api/guard/request` (default capacity=30, refill=1 token/sec).
* Parameter redaction per policy (`allowlist` / `denylist`).
* Use HTTPS in production. Optional mTLS:
  - `TLS_CERT_FILE` / `TLS_KEY_FILE` to enable HTTPS
  - `TLS_CA_FILE` (optional) provide CA for client cert verification
  - `REQUIRE_CLIENT_CERT=true` to enforce client certificate auth (set along with CA)
* Env vars:
  - `RATE_LIMIT_CAPACITY` / `RATE_LIMIT_REFILL_PER_SEC`
  - `SLACK_SIGNING_SECRET`
  - `POLICY_PATH`
  - `PORT`
  - `OVERRIDE_MAX_KEYS` (optional integer; reject override submissions modifying more than this many keys)
  - `OVERRIDE_MAX_CHARS` (optional integer; reject override submissions whose combined changed value length exceeds this)
  - `TRACING_ENABLED` (`true|false`) enable OpenTelemetry tracing (default disabled)
  - `TRACING_EXPORTER` (`console|memory|none`) exporter selection; `memory` for tests only
  - `OTLP_ENDPOINT` (optional) URL for OTLP HTTP trace exporter (e.g. https://otel-collector:4318/v1/traces)
  - `OTLP_HEADERS` (optional) comma-separated key=value pairs added as HTTP headers (e.g. `Authorization=Bearer abc123,X-Env=staging`)
  - `OTLP_TIMEOUT_MS` (optional) request timeout for OTLP exporter
  - `SLACK_UPDATE_QUEUE` (`true|false`) enable coalescing queue for Slack message updates (reduces rate limit pressure)
  - `SLACK_RATE_BASE_DELAY_MS` (optional base backoff delay, default 300)
  - `SLACK_RATE_JITTER_MS` (optional added random jitter, default 150)
  - `ADMIN_TOKEN` (optional) shared secret required in `x-admin-token` header for admin endpoints (policy reload)
  - `REQUEST_RETENTION_SEC` (optional integer >0) purge terminal (approved/denied/expired) requests older than this many seconds
  - `REQUEST_RETENTION_SWEEP_SEC` (optional integer, default 60) interval between retention sweeps
  - `REQUEST_ARCHIVE_FILE` (optional path) if set, purged requests appended as JSONL (fields: version,id,action,status,created_at,decided_at,archivedAt)
  - (Schema) Place per-action JSON schema in `.agent/schemas/<action>.json` to enable validation
  - `TLS_CERT_FILE` / `TLS_KEY_FILE` (optional TLS)
  - `TLS_CA_FILE` (optional, for mTLS)
  - `REQUIRE_CLIENT_CERT` (true/false)
  - `ADMIN_TOKEN` (optional) used to authorize admin operations like policy reload
## Admin Operations

### Policy Reload

Hot-reload the policy file without restarting the server.

Endpoint:
```
POST /api/admin/reload-policy
Headers: x-admin-token: <ADMIN_TOKEN>   # if ADMIN_TOKEN is set
```
Response:
```
{ "ok": true, "actions": <count>, "hash": "<sha256>" }
```
Audit events:
* `policy_reloaded` { source: "api|sighup", actions, hash }
* `policy_reload_failed` { source, error }

Metrics:
```
policy_reloads_total{source="api"} 1
policy_reloads_total{source="sighup"} 0
archived_requests_total{reason="retention"} 5
purged_requests_total{reason="retention"} 5
request_archive_failures_total{reason="retention"} 0
```

SIGHUP support: sending `SIGHUP` (Unix) to the process triggers the same reload path (no auth required, assumed operational control context).

* Future: Redis-backed replay cache & distributed rate limiting.

## Audit Logging
By default audit events (e.g., `request_created`, `request_approved`, `override_applied`) are written to stdout as NDJSON lines.

Durable backends:
* File (append-only NDJSON): set `AUDIT_BACKEND=file` and optionally `AUDIT_FILE=./audit.log.ndjson`.
* Redis Stream: set `AUDIT_BACKEND=redis` and `REDIS_URL=redis://localhost:6379` (stream key defaults to `audit:events`, override via `AUDIT_STREAM`).

Export CLI:
```bash
npm run audit:export -- --since=2025-09-20T00:00:00Z --event=request_approved --limit=50
```

Filter flags:
* `--since=<ISO>` / `--until=<ISO>`
* `--event=<name>`
* `--action=<action>`
* `--limit=<n>`

Note: stdout backend does not currently support export (use shell pipelines). File and Redis backends support server-side filtering during export iteration.

## Load Simulation (Performance / Item #13)

A lightweight load harness is included to exercise the request lifecycle concurrently and report latency percentiles.

Run:
```bash
npm run load-sim -- --requests 500 --concurrency 50 --approve true
```

Flags:
```
--requests <n>        Total number of requests to create (default 100)
--concurrency <n>     Parallel creator workers (default 10)
--approve true|false  If true, immediately applies in-process approvals (default true)
--action <name>       Policy action name used for all requests (default load_action)
```

Environment:
* Uses `POLICY_PATH` if set; otherwise writes a temporary policy enabling a single approver (`ULOAD`).
* Sets `VITEST=1` so the server does not auto-start scheduler / retention loops unintentionally when imported.

Metrics Reported (milliseconds):
* `create_ms` – HTTP round‑trip latency for creating requests.
* `approval_operation_ms` – Time spent executing the approval function (in-memory processing only).
* `end_to_end_ms` – Time from creation (client perceived) through decision (approval) when approvals are applied inline.

Sample Output:
```
--- Load Simulation Summary ---
create_ms: count=500 p50=4.12 p90=6.02 p95=6.89 p99=8.77 max=10.12
approval_operation_ms: count=500 p50=0.06 p90=0.11 p95=0.13 p99=0.20 max=0.31
end_to_end_ms: count=500 p50=4.30 p90=6.22 p95=7.10 p99=8.95 max=10.45
{
  "action": "load_action",
  "requests": 500,
  "concurrency": 50,
  "approve": true,
  "summaries": [
    { "name": "create_ms", "count": 500, "p50": 4.12 },
    { "name": "approval_operation_ms", "count": 500 },
    { "name": "end_to_end_ms", "count": 500 }
  ],
  "errors": []
}
```

Interpretation:
* Compare `end_to_end_ms` vs `create_ms` to estimate non-network processing overhead.
* If adding personas or Slack posting in future tests, expect `end_to_end_ms` to increase; isolate HTTP vs business logic by examining the delta between create and approval operation percentiles..

Future Enhancements:
* Optional ramp profiles (linear / step / spike).
* Slack API mock integration to exercise message update queue.
* Persistent results file with timestamped runs for trend analysis.

## Deployment

(See detailed operational procedures in [Operational Runbook](docs/runbook.md))

Production readiness criteria & go-live gates are tracked in the [Production Readiness Checklist](docs/production-readiness.md). Review it before promoting a new major release to ensure all gates (SLOs, DR test, vulnerability posture, alerts) are satisfied.

### Supply Chain Transparency (SBOM & Provenance)
Tagged releases now publish artifacts in the release workflow containing:
* SBOM (CycloneDX JSON) describing runtime dependencies of the multi-arch image.
* SLSA in-toto provenance attestation (build metadata: builder, recipe, source ref, digest).

Retrieval:
1. Navigate to the GitHub Actions run for the release tag.
2. Download artifacts named `sbom-<tag>.cdx.json` and `provenance-<tag>.intoto.jsonl`.

Validation ideas (manual until automated policy added):
```bash
# Inspect top-level SBOM components
jq '.components | map({name,version,type})[:10]' sbom-v0.1.0.cdx.json

# Verify image digest referenced in provenance matches pulled image digest
ACTUAL=$(docker pull ghcr.io/<owner>/approval-service:v0.1.0 | awk '/Digest/ {print $2}')
grep -q "$ACTUAL" provenance-v0.1.0.intoto.jsonl && echo "Digest matches provenance" || echo "Mismatch" >&2
```

Upcoming enhancements:
* (#45) Image signing (Cosign) to allow `cosign verify-attestation` against provenance.
* Registry-attached SBOM (OCI ref) and automated vulnerability diff gating.
* Policy evaluation of provenance predicate (builder identity, source repo) during deploy.

### Docker
Build the image (multi-stage, Node 20 Alpine):
```bash
docker build -t approval-service:local .
```
Distroless runtime (default final stage now): The default build produces a distroless-based image (`gcr.io/distroless/nodejs20-debian12:nonroot`) for a reduced attack surface (no shell, minimal libraries). For debugging with a shell or package tools, build the `debug` target:
```bash
docker build -t approval-service:debug --target debug .
```
Multi-arch (GHCR releases): Tagged releases publish a manifest supporting `linux/amd64` and `linux/arm64` (see project plan item #42). Local manual multi-arch build example (requires buildx):
```bash
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/<owner>/approval-service:test --push .
```
Run locally exposing port 8080:
```bash
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SLACK_SIGNING_SECRET=changeme \
  -e SLACK_BOT_TOKEN=xoxb-your-token \
  approval-service:local
```
Readiness & health:
```bash
curl -s localhost:8080/healthz    # liveness/basic
curl -s localhost:8080/readyz     # JSON readiness (policy + store)
```
Metrics:
```bash
curl -s localhost:8080/metrics | head
```

Environment (selected runtime vars):
- `PORT` (default 8080 in container)
- `POLICY_PATH` (default `.agent/policies/guards.yml` copied into image; mount volume to override)
- `STORE_BACKEND=redis` and `REDIS_URL=redis://host:6379` to enable Redis persistence
- `TRACING_ENABLED=true` + `TRACING_EXPORTER=otlp` + `OTLP_ENDPOINT=https://otel-collector:4318/v1/traces` for tracing
- Override governance: `OVERRIDE_MAX_KEYS`, `OVERRIDE_MAX_CHARS`
- Retention: `RETENTION_MAX_AGE_SEC`, `RETENTION_SWEEP_INTERVAL_SEC`, `RETENTION_ARCHIVE_DIR`

Mount a custom policy file:
```bash
docker run --rm -p 8080:8080 \
  -v $(pwd)/.agent/policies/guards.yml:/app/.agent/policies/guards.yml:ro \
  -e SLACK_SIGNING_SECRET=... -e SLACK_BOT_TOKEN=... \
  approval-service:local
```

### Kubernetes (Example)
Minimal illustrative manifest (ConfigMap for policy, Deployment, Service):
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: approval-policy
data:
  guards.yml: |
    version: 1
    actions:
      deploy_config:
        allowlist: ["actor.id", "meta.origin.repo"]
        minApprovals: 1
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: approval-service
spec:
  replicas: 2
  selector:
    matchLabels:
      app: approval-service
  template:
    metadata:
      labels:
        app: approval-service
    spec:
      containers:
        - name: app
          image: your-registry/approval-service:latest
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8080
          env:
            - name: PORT
              value: "8080"
            - name: SLACK_SIGNING_SECRET
              valueFrom:
                secretKeyRef:
                  name: approval-secrets
                  key: slack_signing_secret
            - name: SLACK_BOT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: approval-secrets
                  key: slack_bot_token
            - name: POLICY_PATH
              value: /app/policies/guards.yml
            - name: STORE_BACKEND
              value: memory # switch to redis + add REDIS_URL for production persistence
          volumeMounts:
            - name: policy
              mountPath: /app/policies
              readOnly: true
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            initialDelaySeconds: 3
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
      volumes:
        - name: policy
          configMap:
            name: approval-policy
---
apiVersion: v1
kind: Service
metadata:
  name: approval-service
spec:
  selector:
    app: approval-service
  ports:
    - port: 80
      targetPort: 8080
      protocol: TCP
      name: http
```
Notes:
- Replace `your-registry/approval-service:latest` with a tagged image.
- Use `STORE_BACKEND=redis` and inject `REDIS_URL` plus a Redis dependency if persistence / multi-pod reconciliation is required.
- Scale replicas >1 only after enabling Redis to ensure consistent request state across pods.
- Distroless image has no shell; use the `debug` target or ephemeral sidecar if interactive troubleshooting is required.
- Add NetworkPolicies, PodSecurityStandards, and secrets management (SealedSecrets / ExternalSecrets) in production.

### Operational Considerations
- Horizontal scaling: requires Redis backend to avoid diverging in-memory state.
- Tracing: Deploy an OpenTelemetry collector; set OTLP vars.
- Metrics: Add Prometheus scrape annotation or ServiceMonitor.
- Policy changes: Update ConfigMap then `kubectl rollout restart deployment/approval-service` or use admin reload endpoint if file is mounted.
- Backups: Archive directory (if used) should be on a persistent volume or exported to object storage.

### Quick Verification Checklist
1. `curl /healthz` returns `ok` (liveness)
2. `curl /readyz` returns `{ status: "ok" ... }`
3. `curl /metrics` exposes expected counters
4. Create request → Slack message posts
5. Approve in Slack → request transitions to `approved`
6. Decision latency histogram increments (verify scrape)

## Limitations (MVP)
These are intentional scope trims for the pilot; see `docs/project-plan.md` §§6 & 8 for full notes.

* In-memory store (default) loses all active requests on restart. Use Redis (`STORE_BACKEND=redis` + `REDIS_URL`) for durability / multi-instance.
* Horizontal scaling without Redis is unsupported (state not shared across processes).
* Personas: gating flow exists but final MVP enable/ defer decision pending (see `docs/project-plan.md` §7); examples may omit personas for simplicity.
* Slack delivery: basic retry/backoff only; no adaptive rate limit metrics or alerting yet.
* Single escalation notice per request; no re-escalation cadence.
* Load baseline collected locally only (no production SLO yet); see performance snippet below.
* No multi-region failover / DR automation (manual runbook steps only).
* Overrides governance enforces key & diff size limits but no per-field role-based restrictions yet.

### Performance Snapshot
Local load harness (in-memory, 80 requests / concurrency 40): create P95 ≈ 68ms, end-to-end approve P95 ≈ 116ms. Full details: `docs/project-plan.md` §8.

## License
Proprietary (example scaffolding).
