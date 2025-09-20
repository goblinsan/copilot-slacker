import { describe, it, expect } from 'vitest';
import { startServer } from '../src/server.js';

describe('Schema introspection endpoint', () => {
  it('returns sanitized schema without errorMessage', async () => {
    const port = await startServer(0);
    const base = `http://localhost:${port}`;
    const resp = await fetch(`${base}/api/schemas/introspect_demo`);
    expect(resp.status).toBe(200);
    const json: any = await resp.json();
    expect(json.type).toBe('object');
    expect(json.properties.reason).toBeDefined();
    // Should not include custom errorMessage field
    expect(json.properties.reason.errorMessage).toBeUndefined();
    expect(json.properties.reason.minLength).toBe(5);
  });
});
