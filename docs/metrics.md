# Metrics Reference

This document lists all Prometheus metrics exposed at `/metrics` and their semantics.

## Counters

| Name | Labels | Description | Increment Trigger |
|------|--------|-------------|-------------------|
| `approval_requests_total` | action | Number of guard requests created | On request creation & re-request creation |
| `approvals_total` | action | Total approvals recorded (terminal or intermediate) | Each approval action accepted |
| `denies_total` | action | Total denies | Each deny action accepted |
| `expired_total` | action | Requests that expired | Scheduler transitions to expired |
| `escalations_total` | action | Escalation notices fired | Scheduler fires escalation notice |
| `persona_ack_total` | action, persona | Persona acknowledgments | When an approver acks persona requirement |
| `param_overrides_total` | action, outcome | Override submissions categorized by outcome (applied/rejected) | Applied after override_applied; rejected increments on validation failure |
| `override_rejections_total` | action, reason | Override rejections by reason (limit_exceeded, diff_size_exceeded, schema_validation) | Each override_rejected audit increments |
| `security_events_total` | type | Security rejections | Bad signature, stale_signature, replay, rate_limited |

## Histogram

| Name | Labels | Description | Notes |
|------|--------|-------------|-------|
| `decision_latency_seconds` | action, outcome | Time between request creation and terminal state (approved / denied / expired) | Outcome label added when decision recorded |

## Gauges

| Name | Labels | Description |
|------|--------|-------------|
| `pending_requests` | action | Non-terminal requests currently open |
| `open_requests_status` | action, status | Count of open requests by internal status (awaiting_personas, ready_for_approval, pending...) |
| `oldest_open_request_age_seconds` | action | Age in seconds of oldest currently open request |
| `persona_pending_requests` | action, persona | Requests still awaiting each persona |

## Override Governance & Validation Events (Audited, Not Direct Metrics)

While not separate metrics, audit events provide observability beyond counters:

| Audit Event | Reason Field | When Emitted |
|-------------|--------------|--------------|
| `override_rejected` | `limit_exceeded` | Changed key count > `OVERRIDE_MAX_KEYS` |
| `override_rejected` | `diff_size_exceeded` | Sum of changed value string lengths > `OVERRIDE_MAX_CHARS` |
| `override_rejected` | `schema_validation` | Schema validation failed |
| `override_applied` | — | Overrides applied & request approved |

Rejection reasons are now also surfaced via `override_rejections_total{action,reason}` enabling alerting without parsing audit logs.

## Scrape Example

```bash
curl -s http://localhost:3000/metrics | grep decision_latency_seconds
```

## Dashboard Suggestions

1. Request Volume: rate(`approval_requests_total[5m]`) stacked by action.
2. Decision Latency: histogram_quantile(0.95, sum by (le,action) (rate(decision_latency_seconds_bucket[5m]))).
3. Open Requests: `pending_requests` alongside `oldest_open_request_age_seconds` for starvation detection.
4. Override Activity: rate of `param_overrides_total` vs. baseline approvals.
5. Security Events: increase(`security_events_total[1h]`) by type.

## Cardinality Guidance

Avoid unbounded label values. Current labels (`action`, `persona`, `outcome`, `type`, `status`) are controlled by policy and finite enumerations.

---
Update this file when adding or modifying metrics.
