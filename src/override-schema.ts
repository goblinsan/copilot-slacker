/**
 * Override Schema Validation
 *
 * Loads a per-action JSON schema from `.agent/schemas/<action>.json` (if present)
 * and validates only the changed override keys submitted via the Slack modal.
 *
 * Supported subset (kept intentionally small / dependency-free):
 *  - root: { type: 'object', properties: { <key>: { type, enum, pattern, minLength, maxLength, min, max } } }
 *  - property.type ∈ string | number | boolean
 *  - enum: string[] / number[] validation
 *  - pattern: JS regex source (implicitly anchored via new RegExp(pattern))
 *  - minLength / maxLength (strings)
 *  - min / max (numbers)
 * Additional/unknown keywords ignored.
 * Required properties are NOT enforced here because overrides are partial updates.
 * This module deliberately avoids adding a full JSON Schema library to preserve minimal dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

interface PropertySchema {
  type?: 'string' | 'number' | 'boolean';
  enum?: any[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  errorMessage?: string; // custom one-line override for any failure
  // ignore other fields
}
interface ActionSchema {
  type?: string;
  properties?: Record<string, PropertySchema>;
}

const cache = new Map<string, ActionSchema | null>();

function loadSchema(action: string): ActionSchema | null {
  if (cache.has(action)) return cache.get(action)!;
  const schemaPath = path.resolve(process.cwd(), '.agent', 'schemas', `${action}.json`);
  try {
    if (!fs.existsSync(schemaPath)) { cache.set(action, null); return null; }
    const raw = fs.readFileSync(schemaPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      cache.set(action, parsed);
      return parsed;
    }
  } catch {/* swallow & treat as absent */}
  cache.set(action, null);
  return null;
}

export function validateOverrides(action: string, overrides: Record<string, unknown>): { ok: true } | { ok: false; errors: string[] } {
  const schema = loadSchema(action);
  if (!schema || schema.type !== 'object' || !schema.properties) return { ok: true };
  const errors: string[] = [];
  for (const [k, v] of Object.entries(overrides)) {
    const ps = schema.properties[k];
    if (!ps) continue; // Unknown keys already constrained earlier by override allowlist
    if (ps.type) {
      const t = typeof v;
      if (ps.type === 'number') {
        if (t !== 'number') errors.push(`${k}: expected number`);
      } else if (ps.type === 'string') {
        if (t !== 'string') errors.push(`${k}: expected string`);
      } else if (ps.type === 'boolean') {
        if (t !== 'boolean') errors.push(`${k}: expected boolean`);
      }
    }
    if (ps.enum && Array.isArray(ps.enum)) {
      if (!ps.enum.includes(v)) errors.push(`${k}: value not in enum`);
    }
    if (typeof v === 'string') {
      if (ps.pattern) {
        try {
          const re = new RegExp(ps.pattern);
          if (!re.test(v)) errors.push(`${k}: pattern mismatch`);
        } catch { /* invalid pattern ignored */ }
      }
      if (ps.minLength !== undefined && v.length < ps.minLength) errors.push(`${k}: below minLength ${ps.minLength}`);
      if (ps.maxLength !== undefined && v.length > ps.maxLength) errors.push(`${k}: above maxLength ${ps.maxLength}`);
    }
    if (typeof v === 'number') {
      if (ps.min !== undefined && v < ps.min) errors.push(`${k}: below min ${ps.min}`);
      if (ps.max !== undefined && v > ps.max) errors.push(`${k}: above max ${ps.max}`);
    }
    // If custom errorMessage defined and any error recorded for this key, replace all those entries with single custom one
    if (ps.errorMessage) {
      const prefix = `${k}:`;
      const had = errors.some(e => e.startsWith(prefix));
      if (had) {
        // Remove existing errors for k
        for (let i = errors.length -1; i>=0; i--) if (errors[i].startsWith(prefix)) errors.splice(i,1);
        errors.push(`${k}: ${ps.errorMessage}`);
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true };
}

// For tests
export function _clearSchemaCache() { cache.clear(); }

export function totalOverrideCharSize(overrides: Record<string, unknown>): number {
  return Object.values(overrides).reduce<number>((acc, v) => acc + String(v).length, 0);
}
