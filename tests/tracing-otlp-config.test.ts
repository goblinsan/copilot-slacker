import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initTracing, shutdownTracing } from '../src/tracing.js';

// Minimal test to ensure enabling OTLP_ENDPOINT doesn't throw and tracing initializes.
// We can't assert exporter internals without reaching into SDK internals; just ensure no crash.

describe('OTLP tracing config (#38)', () => {
  beforeAll(() => {
    process.env.TRACING_ENABLED = 'true';
    process.env.TRACING_EXPORTER = 'none'; // base exporter none
    process.env.OTLP_ENDPOINT = 'http://localhost:4318/v1/traces'; // dummy
    process.env.OTLP_HEADERS = 'X-Test=1,Authorization=Bearer token';
    process.env.OTLP_TIMEOUT_MS = '1500';
  });
  afterAll(async () => { await shutdownTracing(); delete process.env.OTLP_ENDPOINT; });
  it('initializes without error when OTLP env vars set', () => {
    expect(() => initTracing()).not.toThrow();
  });
});
