import fs from 'node:fs';
import crypto from 'node:crypto';
import yaml from 'yaml';
import type { PolicyAction, PolicyEvaluationResult, PolicyFile } from './types.js';

let cache: { file?: PolicyFile; hash?: string; path?: string } = {};

export function loadPolicy(path: string): PolicyFile {
  const raw = fs.readFileSync(path, 'utf8');
  const file = yaml.parse(raw) as PolicyFile;
  cache.file = file;
  cache.hash = crypto.createHash('sha256').update(raw).digest('hex');
  cache.path = path;
  return file;
}

/** Return last loaded policy file (object reference). */
export function getPolicy(): PolicyFile | undefined { return cache.file; }
/** Return current policy hash (sha256 of raw YAML). */
export function getPolicyHash(): string | undefined { return cache.hash; }
/** Reload policy from original path; throws if no path cached. */
export function reloadPolicy(): PolicyFile {
  if (!cache.path) throw new Error('policy_path_unknown');
  return loadPolicy(cache.path);
}

export function evaluate(action: string, policyFile: PolicyFile): PolicyEvaluationResult | undefined {
  const def = policyFile.actions[action];
  if (!def) {
    if (policyFile.defaults?.unknownAction === 'manual') {
      // Construct a minimal manual policy requiring superApprovers if present
      const superApprovers = policyFile.defaults?.superApprovers || [];
      if (!superApprovers.length) return undefined;
      const synthetic: PolicyAction = { approvers: { allowSlackIds: superApprovers, minApprovals: 1 }, allowParamOverrides: true, overrideKeys: ['reason','count'] } as PolicyAction;
      return materialize(action, synthetic, policyFile);
    }
    return undefined;
  }
  return materialize(action, def, policyFile);
}

function materialize(action: string, p: PolicyAction, policyFile: PolicyFile): PolicyEvaluationResult {
  const timeout = p.timeoutSec || policyFile.routing?.defaultTimeoutSec || 600;
  const redaction = p.redactParams || { mode: 'denylist', keys: [] };
  const channel = p.channel || policyFile.routing?.defaultChannel;
  const hash = cache.hash || 'unknown';
  // Normalize & validate escalation
  let escalation = p.escalation;
  if (escalation) {
    if (escalation.escalateBeforeSec <= 0) throw new Error('escalateBeforeSec must be > 0');
    if (escalation.escalateBeforeSec >= timeout) throw new Error('escalateBeforeSec must be < timeoutSec');
    if (escalation.escalateMinApprovals !== undefined && escalation.escalateMinApprovals < p.approvers.minApprovals) {
      throw new Error('escalateMinApprovals must be >= base minApprovals');
    }
  }
  return {
    action,
    policy: p,
    minApprovals: p.approvers.minApprovals,
    requiredPersonas: p.personasRequired || [],
    timeoutSec: timeout,
    channel,
    escalation,
    redaction: { mode: redaction.mode, keys: redaction.keys || [] },
    policy_hash: hash,
    overrides: { allow: !!p.allowParamOverrides, keys: p.overrideKeys || [] }
  };
}
