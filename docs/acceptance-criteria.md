# Acceptance Criteria Mapping

| Criterion | Implementation Reference | Status |
|-----------|--------------------------|--------|
| Guarded request posts to private channel | `postRequestMessage` in `slack.ts` (channel from policy) | Partial (needs channel config present) |
| Approve unblocks wait | `/api/slack/interactions` approve handler + `/api/guard/wait` poll | Implemented |
| Deny returns refusal | Interaction deny → status `denied` | Implemented |
| Multi-approver policy | `min_approvals` increment logic | Basic (no distinct approver ID tracking) |
| Persona co-sign gating | `required_personas` sets initial state | Partial (no UI ack flow yet) |
| Audit log | `audit()` JSON stdout | Implemented |
| Timeout escalation | Fields present; scheduler not implemented | Pending |
| Policy allowlists | YAML load + evaluation in `policy.ts` | Implemented |
| Redaction | `redactParams()` in `server.ts` | Implemented |
| Token lifecycle & hash | UUID token + SHA-256 hash stored | Implemented |

## Gaps / Next Steps
1. Implement persona acknowledgment interactions (checkbox block & update logic).
2. Track distinct approver user IDs; prevent duplicate approvals & enforce allowlist membership runtime.
3. Add scheduler / worker for timeout expiry & escalation message updates.
4. Provide SSE streaming variant for real-time unblocking beyond polling.
5. Add Redis adapter with TTLs.
6. Add re-request (lineage) flow & rate limiting.
7. Strengthen signature timestamp skew check (<5 minutes) and reject stale requests.
