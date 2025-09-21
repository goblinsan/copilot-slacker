# Quickstart (Real Slack via ngrok)

End-to-end guide to run the Approval Service locally and interact with it through a real Slack workspace using an ngrok tunnel. This complements `docs/quickstart.md` (simulated interaction) by replacing test secrets with actual Slack credentials.

## 1. Prerequisites
- Slack workspace where you can create an app
- Node.js 20+
- npm
- `ngrok` account (free tier fine) + installed CLI
- (Optional) Redis if testing multi-instance semantics (not required for basic flow)

## 2. Create a Slack App
1. Visit https://api.slack.com/apps → `Create New App` → `From scratch`.
2. Name: `ApprovalServiceDev` (any) and select your workspace.
3. (Optional manifest method) Use this to pre-seed scopes + interactivity (will update URL later):
```yaml
display_information:
  name: ApprovalServiceDev
features:
  bot_user:
    display_name: ApprovalBot
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.public
settings:
  interactivity:
    is_enabled: true
    request_url: https://example.com/api/slack/interactions
```

## 3. Add Minimum Bot Scopes
App → `OAuth & Permissions` → Scopes → Bot Token Scopes:
- `chat:write`
- (Optional) `chat:write.public` if posting to channels bot not yet in.
Save.

## 4. Enable Interactivity
App → `Interactivity & Shortcuts` → Enable. Temporary Request URL (placeholder): `https://example.com/api/slack/interactions` (will replace after ngrok starts). Save.

## 5. Install the App
App → `Install App` → `Install to Workspace` → Authorize.
Copy `Bot User OAuth Token` (starts with `xoxb-`). This is your `SLACK_BOT_TOKEN`.

## 6. Obtain Signing Secret
App → `Basic Information` → `App Credentials` → copy `Signing Secret`. This becomes `SLACK_SIGNING_SECRET`.

## 7. Collect Your IDs
In Slack UI:
- User ID: Profile → More → `Copy member ID` (e.g. `U03ABCDEF`).
- Channel ID: Open channel → About → `Copy channel ID` (e.g. `C05XYZ123`). Invite the bot later with `/invite @ApprovalBot` if private.

## 8. Update Policy Allowlist & Channel
Edit `.agent/policies/guards.yml` (example additions):
```yaml
routing:
  defaultChannel: "C05XYZ123"
  dmFallbackUser: "U03ABCDEF"

actions:
  demo:
    description: "Demo action"
    approvers:
      allowSlackIds: ["U03ABCDEF"]
      minApprovals: 1
    timeoutSec: 300
```
Ensure your chosen action (`demo` here) matches the one you will create.

## 9. Start ngrok
Authenticate (once):
```bash
ngrok config add-authtoken <YOUR_NGROK_AUTH_TOKEN>
```
Run tunnel:
```bash
ngrok http 8080
```
Copy the HTTPS forwarding URL, e.g. `https://a1b2c3d4.ngrok-free.app`.

Update Slack Interactivity Request URL to:
```
https://a1b2c3d4.ngrok-free.app/api/slack/interactions
```
Save.

## 10. Export Environment Variables
(Use a bash-compatible shell)
```bash
export SLACK_BOT_TOKEN='xoxb-REPLACE_ME'
export SLACK_SIGNING_SECRET='REPLACE_ME'
export PORT=8080
export POLICY_PATH=.agent/policies/guards.yml
# Faster escalation/expire tests (optional):
export SCHEDULER_INTERVAL_MS=1000
```
(Windows PowerShell equivalent: `$env:SLACK_BOT_TOKEN='xoxb-...';` etc.)

## 11. Install & Start Service
```bash
npm install
npm run dev
```
Confirm no `not_authed` errors appear (if they do, re-check token).

## 12. Create a Guard Request
```bash
curl -s -X POST http://localhost:8080/api/guard/request \
  -H 'Content-Type: application/json' \
  -d '{
    "action":"demo",
    "params":{"ref":"main"},
    "meta":{
      "origin":{"repo":"org/repo","branch":"main"},
      "requester":{"id":"U03ABCDEF","source":"slack","display":"Me"},
      "justification":"test environment change"
    }
  }' | tee /tmp/req.json
```
Expect JSON containing `requestId`, `token`, `status` (e.g. `ready_for_approval`).

## 13. Observe Slack Message
A new message appears in the configured channel. If personas are required for the action, Approve will be disabled until all persona acks are clicked.

## 14. Approve in Slack
Click `Approve`. Message updates (status becomes Approved; buttons disabled). Metrics increment.

## 15. (Optional) Poll or SSE Locally
```bash
TOKEN=$(jq -r '.token' /tmp/req.json)
curl -s "http://localhost:8080/api/guard/wait?token=$TOKEN" | jq
```
SSE:
```bash
curl -N "http://localhost:8080/api/guard/wait-sse?token=$TOKEN"
```

## 16. Metrics Check
```bash
curl -s http://localhost:8080/metrics | grep approvals_total
```
Should show `approvals_total{action="demo"} 1` (value grows with additional approvals).

## 17. Expire / Escalation (Optional)
Using a short-timeout action (e.g. `expire_fast_demo` if in policy):
```bash
curl -s -X POST http://localhost:8080/api/guard/request \
  -H 'Content-Type: application/json' \
  -d '{
    "action":"expire_fast_demo",
    "params":{},
    "meta":{"origin":{"repo":"org/repo"},"requester":{"id":"U03ABCDEF","source":"slack"},"justification":"expire test"}
  }' | jq
```
Watch channel: (1) initial message, (2) escalation thread (may occasionally skip due to tick alignment), (3) expired update.

## 18. Simulate Signed Interaction (Automation Aid)
If you need to programmatically trigger approval without clicking Slack:
```bash
REQ_ID=$(jq -r '.requestId' /tmp/req.json)
PAYLOAD=$(jq -nc --arg id "$REQ_ID" '{type:"block_actions",user:{id:"U03ABCDEF"},actions:[{action_id:"approve",value:$id}]}')
FORM="payload=$(python - <<'PY' "$PAYLOAD"; import urllib.parse,sys,json; print(urllib.parse.urlencode({'payload':sys.argv[1]})); PY)"
TS=$(date +%s)
BASE="v0:$TS:$FORM"
SIG="v0=$(echo -n "$BASE" | openssl dgst -sha256 -hmac "$SLACK_SIGNING_SECRET" -hex | sed 's/^.* //')"
curl -s -X POST http://localhost:8080/api/slack/interactions \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H "x-slack-request-timestamp: $TS" \
  -H "x-slack-signature: $SIG" \
  --data "$FORM"
```
(Replace `U03ABCDEF` with your user ID.)

## 19. Common Issues
| Symptom | Cause | Fix |
|---------|-------|-----|
| `not_authed` log errors | Wrong or missing bot token | Re-copy from Slack `OAuth & Permissions` |
| No Slack message | Bot not invited / wrong channel ID | `/invite @ApprovalBot`; verify channel ID in policy |
| Signature rejected | Stale/incorrect signing secret | Re-copy secret; ensure form body hashing not altered |
| Approve disabled | Personas pending | Ack all persona buttons first |
| Missing escalation occasionally | Scheduler tick alignment | Accept (documented); lower `SCHEDULER_INTERVAL_MS` |
| Replay detected | Reused timestamp+signature | Regenerate signature with new timestamp |

## 20. Cleanup
```bash
# Stop server (Ctrl+C) and ngrok (Ctrl+C window)
unset SLACK_BOT_TOKEN SLACK_SIGNING_SECRET
```
(Or close the shell.)

## 21. Next Steps
- Try `npm run reliability:sse` for multi-iteration stability.
- Add more approvers/personas in policy and observe gating.
- Switch to Redis backend (`STORE_BACKEND=redis REDIS_URL=redis://localhost:6379`) for persistence tests.

---
**Security Reminder:** Never commit real `SLACK_BOT_TOKEN` or `SLACK_SIGNING_SECRET`. For team sharing use a secret manager or `.env.local` excluded via `.gitignore`.
