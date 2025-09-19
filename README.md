# Approval Service (Slack Guard)

Slack-based approval gate for LLM / agent risky operations (dependency install, migrations, config changes, etc.).

## Features
* Guarded action requests with policy-driven routing and timeouts.
* Slack interactive Approve / Deny buttons.
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

## Security Notes
* Verify Slack signatures before processing interactions.
* Redact parameters according to policy.
* Use HTTPS in production (ngrok for local).

## License
Proprietary (example scaffolding).
