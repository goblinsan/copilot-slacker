/**
 * Global test setup: stabilize environment & reduce cross-test interference.
 * Responsibilities:
 *  - Ensure VITEST flag set so code can branch appropriately for tests.
 *  - Snapshot a baseline of process.env and restore mutable keys after each test file.
 *  - Provide utilities for clearing timers/listeners if needed in future.
 * Non-goals: heavy mocking (handled per test) or network interception.
 */

import { beforeEach } from 'vitest';
import { __TEST_clearStore } from '../src/store.js';
import { resetAllMetrics } from '../src/metrics.js';
import { clearReplayCache } from '../src/replay.js';
import { clearRateLimits } from '../src/ratelimit.js';

const BASE_ENV = { ...process.env };
process.env.VITEST = '1';
// Provide a default signing secret so tests that don’t explicitly set one still produce valid signatures.
if (!process.env.SLACK_SIGNING_SECRET) process.env.SLACK_SIGNING_SECRET = 'test_secret';

// Keys we allow tests to mutate; everything else reverts to baseline.
// We track differences dynamically so new env vars don't leak.
// NOTE: Original implementation restored the entire environment after each test to the baseline.
// This caused problems for multi-step integration tests that rely on values set in a file-level
// beforeAll (e.g., SLACK_SIGNING_SECRET used to sign multiple Slack interaction requests across
// several `it` blocks). Clearing the secret between tests led to 400 bad_signature responses on
// subsequent steps. To preserve deterministic behavior for those flows while still avoiding large
// uncontrolled mutation, we no longer auto-restore after every test. If a specific test mutates
// global environment variables in a way that could affect later files, it should reset them
// manually. We retain this helper (currently unused) should we want a manual restore in the future.
function restoreEnv() {/* intentionally inert now */}

// Vitest global hooks (executed once per test file load context)
// We rely on per-file afterAll cleanup where servers/schedulers are started.

// Perform an initial reset immediately upon setup import to ensure the very first
// test file starts with a clean slate (important in CI ordering differences).
__TEST_clearStore();
resetAllMetrics();
clearReplayCache();
clearRateLimits();

let lastTestFile: string | undefined;

beforeEach(async () => {
  const state = (globalThis as any).expect?.getState?.();
  const current = state?.testPath as string | undefined;
  if (current && current !== lastTestFile) {
    __TEST_clearStore();
    resetAllMetrics();
    clearReplayCache();
    clearRateLimits();
    lastTestFile = current;
  }
});
