# Request Lineage (Re-Request Flow)

Lineage allows submitting a follow-up request derived from a previous one (e.g., redeploy or retry) while enforcing cooldown and rate limits.

## Concepts
- `lineage_id`: Stable identifier referencing the original root request.
- `rerequest`: Operation creating a new request inheriting action/meta and redacted params.

## Current Limits
- Max 5 re-requests (original + 5 = 6 total) per 24h window.
- Cooldown: Controlled by policy field `reRequestCooldownSec` (0 = disabled).

## Endpoint
`POST /api/guard/rerequest`
```json
{
  "originalRequestId": "<uuid>",
  "actor": {"id":"U123","source":"slack"}
}
```
Response:
```json
{
  "token": "...",
  "requestId": "...",
  "lineageId": "...",
  "status": "ready_for_approval"
}
```

## Policy Enablement
```yaml
actions:
  demo:
    allowReRequest: true
    reRequestCooldownSec: 300
```

## Future Enhancements
- Lineage summary block in Slack root message.
- Metrics: `rerequests_total{action}`.
- Lineage depth visualization.
