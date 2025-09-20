# Copilot Instructions – Approval Service Project

These instructions guide AI-assisted contributions so changes align with architecture, security, and roadmap.

## Core Principles
1. Security First: Never bypass signature verification, allowlist checks, or redaction logic.
2. Incremental Delivery: Implement one backlog item per PR unless explicitly batching refactors.
3. Deterministic Behavior: All state transitions must be idempotent and concurrency-safe.
4. Minimal Dependencies: Prefer standard library + existing deps (zod, yaml, @slack/web-api). Avoid adding new libs without justification.
5. Observability by Default: New features should include audit events and (if applicable) metrics hooks.

## Repository Domains
| Area | Files / Directories | Notes |
|------|---------------------|-------|
| HTTP API | `src/server.ts` | Add endpoints cautiously; update OpenAPI in `docs/api.md`. |
| Policies | `.agent/policies/guards.yml`, `src/policy.ts` | Validate schema changes & document. |
| Slack Integration | `src/slack.ts` | Keep scopes minimal; reuse block composition helpers. |
| Persistence | `src/store.ts` (in-memory), future `src/store/redis.ts` | Provide interface abstraction for swapping stores. |
| SDK / MCP Tools | `src/sdk/` | Keep language-agnostic semantics documented. |
| Docs | `docs/*.md` | Update versioned diagrams if altering flows. |

## Coding Standards
* TypeScript strict mode (no implicit any).
* Functions < ~75 LOC; extract helpers when exceeding.
* Start new modules with a short JSDoc describing responsibility + non-goals.
* Prefer pure functions for policy and redaction logic.
* Avoid mutating shared objects outside controlled store methods.
* Export only what is necessary (minimize surface area).

## Security Requirements (Must Not Break)
| Concern | Rule |
|---------|------|
| Slack Signature | Always verify before parsing action; enforce timestamp skew (<300s) once implemented. |
| Replay | Do not remove replay protection cache when added. |
| Allowlist | Every approval/deny must pass allowlist or superApprover check. |
| Redaction | Never log raw params; use redacted view for Slack. |
| Token Privacy | Do not expose internal request token in Slack messages. |

## Backlog Mapping
Each PR should reference a backlog ID from `docs/project-plan.md` (e.g., `Implements: #1 Enforce approver allowlists`).

### Implementation Priorities
1. (#1) Allowlist Enforcement
2. (#2) Unique Approval Tracking
3. (#3) Persona Checklist Flow
4. (#4) Redis Adapter
5. (#5) Timeout & Escalation Scheduler
... (continue per plan)

## Commit & PR Guidelines
| Aspect | Requirement |
|--------|-------------|
| Commit Message | Conventional: `feat(store): add redis adapter` or `fix(security): reject stale signatures` |
| PR Description | Include: Problem, Approach, Testing, Risk, Backlog ID |
| Tests | Mandatory for logic branches & security paths |
| Docs | Update if public API / sequence changes |

## Testing Strategy
| Layer | Tool | Scope |
|-------|------|-------|
| Unit | Vitest | Policy evaluation, redaction, signature verify |
| Integration | Vitest + mock Slack | Request→approve/deny workflows |
| Load (later) | Custom script / k6 | Latency & concurrency stress |

## Metrics Hook Points (Once Implemented)
| Event | Metric | Action |
|-------|--------|--------|
| Request created | `approval_requests_total` | Increment counter |
| Approval added | `approvals_total` | Increment counter |
| Deny | `denies_total` | Increment counter |
| Expired | `expired_total` | Increment counter |
| Escalation | `escalations_total` | Increment counter |
| Terminal state | `decision_latency_seconds` | Observe duration |

## Redis Adapter Expectations
* Key naming: `req:{id}`, `approvals:{id}`, `persona:{id}`.
* Use atomic scripts (Lua or MULTI/EXEC) for approval & persona transitions.
* TTL set on `req:{id}` equal to `timeoutSec + grace` (grace ~ 120s) for cleanup.

## SSE Endpoint Expectations
* Content-Type: `text/event-stream`.
* Flush `state` event immediately after client connects.
* Send heartbeat event every 25s: `event: heartbeat` with empty data.
* Close stream after terminal state.

## Persona Interaction Flow
1. Initial message: Approve disabled (or absent) if personas required.
2. Persona acks update checklist block (checked items) and progress context.
3. When all ack → render / enable Approve buttons.
4. Deny at any stage remains allowed by authorized approver.

## Re-request (Lineage) Flow (Future)
* New request obtains `lineage_id` referencing original `requestId`.
* Slack message includes lineage link (`Lineage: #<short-id>`).
* Rate limit lineage re-requests (policy or default: 5 / 24h).

## Do / Don’t Summary
| Do | Don’t |
|----|-------|
| Enforce policy before state mutation | Skip validation for convenience |
| Add tests for each new branch | Leave security paths untested |
| Keep Slack blocks minimal & performant | Fetch full channel history |
| Use environment vars for secrets | Hardcode tokens or secrets |
| Document new env vars in README | Introduce silent config changes |

## Open Questions (Document Before Implementing)
* Should persona revocation (uncheck) be allowed? Default: no.
* Should multi-approver approvals show order/timestamps inline? Proposed: yes (future enhancement).
* Approve with edits modal schema storage—central registry or per-action inline spec? Proposed: JSON schema file per action.

## Quick Reference (Frequently Used Commands)
```bash
# Run dev server
npm run dev

# Run tests
npm test

# Type check
npm run build --noEmit

# Lint (when configured)
npm run lint
```

---
Keep this file updated when architecture or standards evolve. Changes to this file should be reviewed like code.
