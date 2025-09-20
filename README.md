# Approval Service (Slack Guard)

Slack-based approval gate for LLM / agent risky operations (dependency install, migrations, config changes, etc.).

## Features
* Guarded action requests with policy-driven routing and timeouts.
* Slack interactive Approve / Deny buttons.
* Optional parameter override modal (policy-gated safe edits prior to approval).
* Override governance (limit changed keys, audited diffs & rejections).
* Persona co-sign (scaffolding present; enrichment TBD).
* Audit logging (stdout JSON lines).
* Pluggable store (in-memory; replace with Redis adapter).

## Quickstart (Local)
```bash
git clone <repo>
cd copilot-slacker
cp .env.example .env
npm install
npm run dev
```

In another terminal (simulate agent):
```bash
curl -X POST http://localhost:3000/api/guard/request \
  -H 'Content-Type: application/json' \
  -d '{
    "action":"npm_install",
    "params":{"packages":["lodash@^4.17.21"]},
    "meta": {"origin":{"repo":"acme/web","branch":"feature/x"},"requester":{"id":"agent-1","source":"agent"},"justification":"Security patch"}
  }'
```

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

### TODO / Next Steps
* Implement persona checkbox interactions & enabling Approve only when acked.
* Add Redis adapter & TTL expiry sweep.
* Add scheduler for timeout + escalation.
* SSE streaming endpoint (currently simple long-poll).
* Robust approval duplication prevention & user ID allowlist enforcement.

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
 param_overrides_total{action="<action>"}
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

## SSE Streaming (Real-Time Updates)

After creating a request the creator receives a `token` (response of `/api/guard/request`). Use the SSE endpoint to stream live state transitions until the request becomes terminal (`approved`, `denied`, or `expired`). A heartbeat event is sent every ~25 seconds to keep idle connections alive.

Endpoint:
```
GET /api/guard/wait-sse?token=<TOKEN>
```

Example with curl:
```
curl -N "http://localhost:3000/api/guard/wait-sse?token=$TOKEN"
```

Sample event flow:
```
event: state
data: {"status":"ready_for_approval","approvers":[]}

event: state
data: {"status":"approved","approvers":["U456"],"decidedAt":"2025-09-20T02:43:20.156Z"}
```

Node client snippet:
```js
import EventSource from 'eventsource';
const es = new EventSource(`http://localhost:3000/api/guard/wait-sse?token=${token}`);
es.addEventListener('state', ev => {
  const data = JSON.parse(ev.data);
  console.log('state update', data);
  if(['approved','denied','expired'].includes(data.status)) es.close();
});
es.addEventListener('heartbeat', () => {/* optional keep-alive */});
```

Fallback (if proxies strip SSE): poll `GET /api/guard/wait?token=<TOKEN>` every few seconds or POST to the same path to retrieve current state.

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
8. Optional schema validation: if a file `.agent/schemas/<action>.json` exists it is loaded and each changed key is validated against a minimal schema subset (type, enum, pattern, minLength, maxLength, min, max). Failures reject the submission with `override_rejected` (reason `schema_validation`).

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
* Schema validation per action (reject malformed values).
* Governance limits (max keys changed, diff size enforcement).
* Audit enrichment with before/after diffs (with redaction honored).
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
  - (Schema) Place per-action JSON schema in `.agent/schemas/<action>.json` to enable validation
  - `TLS_CERT_FILE` / `TLS_KEY_FILE` (optional TLS)
  - `TLS_CA_FILE` (optional, for mTLS)
  - `REQUIRE_CLIENT_CERT` (true/false)
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

## License
Proprietary (example scaffolding).
