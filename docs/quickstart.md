# Quickstart

This guide helps you run the Approval Service locally in minutes.

## Prerequisites
- Node 20+
- npm
- (Optional) Redis if using redis backend

## 1. Install Dependencies
```
npm install
```

## 2. Run Tests (sanity)
```
npm test
```

## 3. Start Service (Memory Store)
```
PILOT_MODE=true SLACK_SIGNING_SECRET=test_secret SLACK_BOT_TOKEN=xoxb-test npm run dev
```
Service listens on `:8080` by default (override with `PORT`).

## 4. Create a Request
```
curl -s -X POST localhost:8080/api/guard/request \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "demo",
    "params": {"ref":"main"},
    "meta": {"origin":{"repo":"org/repo"}, "requester":{"id":"U1","source":"slack"}, "justification":"deploy"}
  }'
```
Response contains `token` and `requestId`.

## 5. Poll Status
```
TOKEN=... # from previous step
curl -s "localhost:8080/api/guard/wait?token=$TOKEN"
```

## 6. SSE Stream (Optional)
Open another terminal:
```
curl -N "localhost:8080/api/guard/wait-sse?token=$TOKEN"
```
You will see `event: state` updates.

## 7. Approve via Simulated Slack Interaction
```
REQ_ID=... # requestId from step 4
PAYLOAD=$(jq -nc --arg id "$REQ_ID" '{type:"block_actions", user:{id:"UAPP"}, actions:[{action_id:"approve", value:$id}] }')
TS=$(date +%s)
SECRET=test_secret
SIG=$(printf "v0:%s:%s" "$TS" "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -r | awk '{print "v0=" $1}')
curl -s -X POST localhost:8080/slack/interact \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H "x-slack-request-timestamp: $TS" \
  -H "x-slack-signature: $SIG" \
  --data-urlencode "payload=$PAYLOAD"
```

Re-poll or watch SSE to observe terminal state.

## 8. Shut Down
`Ctrl+C` the dev server.

---
For Redis usage set `STORE_BACKEND=redis` and supply `REDIS_URL`. See `docs/redis.md` (future).
