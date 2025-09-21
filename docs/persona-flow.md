# Persona Flow

Requests can require acknowledgement from one or more personas before approval is enabled.

## States
- `awaiting_personas`: Initial when at least one required persona is pending.
- `ready_for_approval`: All personas acknowledged; approvals may proceed.

## Persona State Tracking
Each required persona has a state:
- `pending`
- `acked`

Slack interactive updates (checkbox block or button) transition a persona from `pending` -> `acked`. (Un-ack is currently not supported.)

## Example Policy (Excerpt)
```yaml
actions:
  prod_deploy:
    approvers:
      allowSlackIds: [U123, U456]
      minApprovals: 1
    personasRequired: [security, release]
```

## UX Progression
1. Initial message: approval button disabled or absent; checklist of personas shown.
2. Persona members click acknowledge.
3. On final ack: message updates, approval action appears/enabled.
4. Approval proceeds normally counting toward min quorum.

## Metrics (Planned)
- `persona_pending_requests{action,persona}` gauge (already emitted).

## Open Questions
- Allow revocation? (Current: No.)
- Display ack timestamps inline? (Future enhancement.)
