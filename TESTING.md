# Testing Strategy

This project uses a layered approach to keep security paths deterministic and fast.

## Layers

1. Unit & Logic (Vitest)
   - Policy evaluation, signature verification, replay detection, redaction, overrides.
2. Integration
   - Full request lifecycle: create → (personas) → approve/deny/expire; SSE streaming; Redis adapter behavior.
3. Deterministic Scheduler Unit
   - Uses `__TEST_runSchedulerAt(ms)` hook to simulate escalation & expiration timestamps without real sleeps.
4. Smoke (this script)
   - Minimal real HTTP flow against a running server to ensure golden path still functions post-build.

## Running Tests

```bash
npm test            # Unit & integration
npm run typecheck   # TS compile check
```

## Smoke Test

The smoke test can exercise one or more terminal paths (approve, deny) plus perform metrics assertions.

```bash
# Start server in one shell
npm run dev &
# Run default smoke (approve only, defaults to port 8080)
npm run smoke

# Run approve + deny
npx tsx scripts/smoke.ts --scenarios=approve,deny

# Override approver / denier user IDs (must exist in policy allowSlackIds)
SMOKE_APPROVE_USER=U123 SMOKE_DENY_USER=U456 npx tsx scripts/smoke.ts --scenarios=approve,deny

# (Placeholder) include expire scenario once fast timeout path exposed
npx tsx scripts/smoke.ts --scenarios=approve,deny,expire
```

CI will run the smoke script after the normal test/build cycle using the in-repo code.

Exit codes:
- 0 success
- 1 failure (creation, interaction, polling, metrics, or timeout)

## Redis vs Memory

Set `STORE_BACKEND=redis` with `REDIS_URL` in CI / local to exercise Redis path. Unit tests default to memory unless overridden.

## Pilot Mode Notes

When `PILOT_MODE=true`, capacity enforcement may reject creates if too many open requests exist. The smoke script currently assumes capacity is available; adjust (or drain) if you see `pilot_capacity_reached`.

## Adding New Tests

- Favor adding helper functions to `tests/test-helpers.ts` for repeated HTTP flows.
- Keep new functions < ~75 LOC; split helper logic if larger.
- Always assert security-relevant branches (bad signature, stale timestamp, replay) at least once.

## Future Enhancements (Placeholder)

- Load test harness (k6) once scaling targets are defined.
- Additional persona revocation scenarios if feature is enabled.
- Fast-expire scenario parameter (custom short timeout) for smoke `expire` validation.
- Metrics delta validation (compare before/after rather than presence only).
