# Dashboards

Placeholder for baseline observability assets.

Planned initial panels (Grafana or similar):
- `approval_requests_total` counter (rate by action)
- `decision_latency_seconds` histogram (p50/p90 by outcome)
- `open_requests_status` gauge (stacked by status per action)
- `persona_pending_requests` gauge (if personas used)
- `expired_total` / `escalations_total` counters

The accompanying `baseline-dashboard.json` will be exported after first pilot scrape.
