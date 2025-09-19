import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/policy.js';

describe('policy evaluate', () => {
  it('returns undefined for unknown when default deny', () => {
    const res = evaluate('unknown_action', { actions: {}, defaults: { unknownAction: 'deny' } });
    expect(res).toBeUndefined();
  });
});
