/**
 * Centralized environment configuration & validation.
 * Responsibility: Parse, validate, and expose strongly typed configuration.
 * Non-goals: Runtime mutation (treat as immutable), complex secret management (delegate to platform).
 */

export interface Config {
  port: number;
  policyPath: string;
  slackSigningSecret: string;
  slackBotToken: string;
  tracingEnabled: boolean;
  tracingExporter: 'console' | 'otlp' | 'none';
  otlpEndpoint?: string;
  redisUrl?: string;
  storeBackend: 'memory' | 'redis';
  overrideMaxKeys: number;
  overrideMaxChars: number;
  retentionSweepIntervalSec: number;
  retentionMaxAgeSec: number;
  retentionArchiveDir: string;
}

function num(envVal: string | undefined, def: number, opts?: { min?: number; max?: number }): number {
  if (envVal === undefined || envVal === '') return def;
  const n = Number(envVal);
  if (Number.isNaN(n)) return def;
  if (opts?.min !== undefined && n < opts.min) return opts.min;
  if (opts?.max !== undefined && n > opts.max) return opts.max;
  return n;
}

function bool(envVal: string | undefined, def: boolean): boolean {
  if (envVal === undefined) return def;
  return envVal === 'true' || envVal === '1';
}

export function loadConfig(): Config {
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET || '';
  const slackBotToken = process.env.SLACK_BOT_TOKEN || '';

  // In production these should be set.
  if (process.env.NODE_ENV === 'production') {
    if (!slackSigningSecret) throw new Error('SLACK_SIGNING_SECRET required in production');
    if (!slackBotToken) throw new Error('SLACK_BOT_TOKEN required in production');
  }

  const tracingEnabled = bool(process.env.TRACING_ENABLED, false);
  let tracingExporter: Config['tracingExporter'] = 'none';
  if (tracingEnabled) {
    const raw = (process.env.TRACING_EXPORTER || 'console').toLowerCase();
    tracingExporter = raw === 'otlp' ? 'otlp' : 'console';
  }

  const cfg: Config = {
    port: num(process.env.PORT, 8080, { min: 1, max: 65535 }),
    policyPath: process.env.POLICY_PATH || '.agent/policies/guards.yml',
    slackSigningSecret,
    slackBotToken,
    tracingEnabled,
    tracingExporter,
    otlpEndpoint: process.env.OTLP_ENDPOINT || undefined,
    redisUrl: process.env.REDIS_URL || undefined,
    storeBackend: (process.env.STORE_BACKEND === 'redis' ? 'redis' : 'memory'),
    overrideMaxKeys: num(process.env.OVERRIDE_MAX_KEYS, 8, { min: 1, max: 64 }),
    overrideMaxChars: num(process.env.OVERRIDE_MAX_CHARS, 2000, { min: 100, max: 20000 }),
    retentionSweepIntervalSec: num(process.env.RETENTION_SWEEP_INTERVAL_SEC, 60, { min: 5, max: 3600 }),
    retentionMaxAgeSec: num(process.env.RETENTION_MAX_AGE_SEC, 86400, { min: 60, max: 86400 * 30 }),
    retentionArchiveDir: process.env.RETENTION_ARCHIVE_DIR || 'archive'
  };

  return cfg;
}

let cached: Config | undefined;
export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
