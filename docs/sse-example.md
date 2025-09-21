# SSE Example

Server-Sent Events allow near-real-time streaming of request state changes.

## Endpoint
`GET /api/guard/wait-sse?token=<token>`

Headers returned:
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`

## Event Types
- `state`: JSON encoded request snapshot (status, approvals_count, personas, etc.)
- `heartbeat`: Every ~25s to keep connection alive (future enhancement)

## Sample Session
```
$ curl -N "localhost:8080/api/guard/wait-sse?token=..."
event: state
data: {"status":"ready_for_approval","approvals_count":0}

# After approval
event: state
data: {"status":"approved","approvals_count":1}
```

## Client Tips
- Reconnect with exponential backoff (start 250ms up to 5s) if socket closes unexpectedly before terminal state.
- Treat any malformed line as a transient error; reconnect.
- Stop listening after terminal status (`approved|denied|expired`).
