import { z } from 'zod';

// Core Schemas
export const OriginSchema = z.object({
  repo: z.string(),
  branch: z.string().optional(),
  pr: z.string().optional(),
  run_id: z.string().optional()
});

export const RequesterSchema = z.object({
  id: z.string(),
  source: z.enum(['slack','github','agent']),
  display: z.string().optional()
});

export const MetaSchema = z.object({
  origin: OriginSchema,
  requester: RequesterSchema,
  justification: z.string().min(3),
  links: z.array(z.object({ label: z.string(), url: z.string().url() })).optional()
});

export const CreateRequestInputSchema = z.object({
  action: z.string().min(1),
  params: z.record(z.any()).default({}),
  meta: MetaSchema,
  policyHints: z.record(z.any()).optional()
});

export type CreateRequestInput = z.infer<typeof CreateRequestInputSchema>;

export const RequestStatusSchema = z.enum([
  'pending','awaiting_personas','ready_for_approval','approved','denied','expired'
]);

export type RequestStatus = z.infer<typeof RequestStatusSchema>;

export interface GuardRequestRecord {
  id: string;
  token: string; // opaque token for wait
  action: string;
  payload_hash: string;
  redacted_params: Record<string, unknown>;
  meta: CreateRequestInput['meta'];
  status: RequestStatus;
  min_approvals: number;
  approvals_count: number;
  required_personas: string[];
  persona_state: Record<string, 'pending'|'ack'|'rejected'>;
  expires_at: string; // ISO
  created_at: string;
  decided_at?: string;
  slack_channel?: string;
  slack_message_ts?: string;
  policy_hash: string;
  lineage_id?: string;
}

export interface ApprovalRecord {
  id: string;
  request_id: string;
  actor_slack_id: string;
  actor_type: 'human'|'persona';
  decision: 'approved'|'denied';
  param_overrides?: Record<string, unknown>;
  created_at: string;
}

export interface PersonaSignalRecord {
  id: string;
  request_id: string;
  persona: string;
  actor_slack_id: string;
  state: 'pending'|'ack'|'rejected';
  notes?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export const WaitRequestInputSchema = z.object({ token: z.string() });
export type WaitRequestInput = z.infer<typeof WaitRequestInputSchema>;

export interface WaitResponse {
  status: RequestStatus;
  approvers?: string[];
  decisionParams?: Record<string, unknown>;
  reason?: string;
  decidedAt?: string;
}

export interface PolicyAction {
  description?: string;
  approvers: {
    allowSlackIds?: string[];
    allowHandles?: string[];
    minApprovals: number;
  };
  personasRequired?: string[];
  timeoutSec?: number;
  redactParams?: { mode: 'allowlist'|'denylist'|'all'; keys?: string[] };
  channel?: string;
  escalation?: { afterSec: number; fallbackUser?: string };
  allowReRequest?: boolean;
  reRequestCooldownSec?: number;
}

export interface PolicyFile {
  actions: Record<string, PolicyAction>;
  routing?: { defaultChannel?: string; dmFallbackUser?: string; defaultTimeoutSec?: number };
  defaults?: { unknownAction?: 'deny'|'manual'; superApprovers?: string[] };
}

export interface PolicyEvaluationResult {
  action: string;
  policy: PolicyAction;
  minApprovals: number;
  requiredPersonas: string[];
  timeoutSec: number;
  channel: string | undefined;
  escalation?: PolicyAction['escalation'];
  redaction: { mode: 'allowlist'|'denylist'|'all'; keys: string[] };
  policy_hash: string;
}

export interface SlackMessageIds { channel: string; ts: string }
