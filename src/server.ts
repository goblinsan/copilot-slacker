import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { CreateRequestInputSchema, WaitRequestInputSchema, RequestStatus, RequestStatusSchema } from './types.js';
import { loadPolicy, evaluate, getPolicy, reloadPolicy } from './policy.js';
import { Store } from './store.js';
import { postRequestMessage, verifySlackSignature, updateRequestMessage, slackClient } from './slack.js';
import { applyApproval, applyDeny } from './approval.js';
import { startScheduler } from './scheduler.js';
import crypto from 'node:crypto';
import { audit } from './log.js';
import { incCounter, serializePrometheus } from './metrics.js';
import { addListener, emitState, sendEvent, broadcastForRequestId } from './sse.js';
import { markAndCheckReplay } from './replay.js';
import { isAllowed as rateLimitAllowed } from './ratelimit.js';
import { validateOverrides, totalOverrideCharSize, loadActionSchema } from './override-schema.js';
import { withSpan, initTracing } from './tracing.js';
import { startRetentionSweeper } from './retention.js';
import { getConfig } from './config.js';

const cfg = getConfig();
const POLICY_PATH = cfg.policyPath;
// Load initial policy; subsequent accesses should use getPolicy() for latest reference
loadPolicy(POLICY_PATH);

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function notFound(res: http.ServerResponse) { res.statusCode = 404; res.end('Not found'); }

// Server instance (HTTP by default, HTTPS if cert env vars provided)
let server: http.Server | https.Server;

function ensureServer() {
  if (server) return;
  const certFile = process.env.TLS_CERT_FILE;
  const keyFile = process.env.TLS_KEY_FILE;
  if (certFile && keyFile && fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const requireClient = process.env.REQUIRE_CLIENT_CERT === 'true';
    const options: https.ServerOptions = {
      cert: fs.readFileSync(certFile),
      key: fs.readFileSync(keyFile),
      requestCert: requireClient,
      rejectUnauthorized: requireClient
    };
    const caFile = process.env.TLS_CA_FILE;
    if (caFile && fs.existsSync(caFile)) options.ca = fs.readFileSync(caFile);
    server = https.createServer(options, handler);
  } else {
    server = http.createServer(handler);
  }
}

async function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  // Lazy tracing init (idempotent) to avoid requiring explicit call in startup path
  if (process.env.TRACING_ENABLED === 'true') initTracing();
  // If client cert required, reject unauthorized early
  if (process.env.REQUIRE_CLIENT_CERT === 'true') {
    const socket: any = req.socket as any;
    if (!socket.authorized) { res.writeHead(401); return res.end('client_cert_required'); }
  }
  
  if (req.method === 'GET' && req.url?.startsWith('/healthz')) { res.end('ok'); return; }
  if (req.method === 'GET' && req.url === '/metrics') {
    const base = await serializePrometheus(async () => {
      if (!Store.listOpenRequests) return {};
      const open = await Store.listOpenRequests();
      const byAction: Record<string, number> = {};
      for (const r of open) byAction[r.action] = (byAction[r.action]||0)+1;
      return byAction;
    });
    // Append extended gauges: open_requests_status{action,status} and oldest_open_request_age_seconds{action}
    let extra = '';
    if (Store.listOpenRequests) {
      const open = await Store.listOpenRequests();
      const statusCounts: Record<string, Record<string, number>> = {};
      const oldestAge: Record<string, number> = {};
      const personaPending: Record<string, Record<string, number>> = {}; // action -> persona -> count
      const now = Date.now();
      for (const r of open) {
        statusCounts[r.action] ||= {};
        statusCounts[r.action][r.status] = (statusCounts[r.action][r.status]||0)+1;
        const created = new Date(r.created_at).getTime();
        const ageSec = (now - created)/1000;
        if (!oldestAge[r.action] || ageSec > oldestAge[r.action]) oldestAge[r.action] = ageSec;
        // persona pending gauge population
        if (r.required_personas?.length) {
          for (const p of r.required_personas) {
            if (r.persona_state?.[p] === 'pending') {
              personaPending[r.action] ||= {};
              personaPending[r.action][p] = (personaPending[r.action][p] || 0) + 1;
            }
          }
        }
      }
      extra += '# TYPE open_requests_status gauge\n';
      for (const [action, byStatus] of Object.entries(statusCounts)) {
        for (const [status,count] of Object.entries(byStatus)) {
          extra += `open_requests_status{action="${action}",status="${status}"} ${count}\n`;
        }
      }
      extra += '# TYPE oldest_open_request_age_seconds gauge\n';
      for (const [action, age] of Object.entries(oldestAge)) {
        extra += `oldest_open_request_age_seconds{action="${action}"} ${age.toFixed(3)}\n`;
      }
      if (Object.keys(personaPending).length) {
        extra += '# TYPE persona_pending_requests gauge\n';
        for (const [action, byPersona] of Object.entries(personaPending)) {
          for (const [persona, count] of Object.entries(byPersona)) {
            extra += `persona_pending_requests{action="${action}",persona="${persona}"} ${count}\n`;
          }
        }
      }
    }
    res.writeHead(200,{ 'Content-Type':'text/plain; version=0.0.4' });
    res.end(base + extra);
    return;
  }
  // Schema introspection endpoint (returns sanitized override schema for action)
  if (req.method === 'GET' && req.url?.startsWith('/api/schemas/')) {
    const action = decodeURIComponent(req.url.split('/').pop()||'');
    if (!action) return json(res,400,{ error:'missing_action' });
    const schema = loadActionSchema(action);
    if (!schema) return json(res,404,{ error:'not_found' });
    // Sanitize: remove any errorMessage fields
    const sanitized = { type: schema.type, properties: {} as Record<string, any> };
    for (const [k,v] of Object.entries(schema.properties||{})) {
      const { errorMessage, ...rest } = v as any;
      sanitized.properties[k] = rest;
    }
    return json(res,200,sanitized);
  }
  // Re-request lineage endpoint
  if (req.method === 'POST' && req.url === '/api/guard/rerequest') {
    return withSpan('request.rerequest', async span => {
    const body = await readBody(req);
    let parsed: any; try { parsed = JSON.parse(body); } catch { return json(res,400,{error:'invalid_payload'}); }
    const { originalRequestId, actor } = parsed || {};
    if (!originalRequestId || !actor) return json(res,400,{error:'missing_fields'});
    const original = await Store.getById(originalRequestId);
    if (!original) return json(res,404,{error:'not_found'});
  const currentPolicy = getPolicy();
  const evalResult = currentPolicy ? evaluate(original.action, currentPolicy) : undefined;
    if (!evalResult || !evalResult.policy.allowReRequest) return json(res,403,{error:'not_allowed'});
    span.setAttribute?.('action', original.action);
    const cooldown = evalResult.policy.reRequestCooldownSec || 0;
    const lineageId = original.lineage_id || original.id;
    const lineage = (await Store.listLineageRequests?.(lineageId)) || [];
    // Rate limit: max 5 in rolling 24h (including original)
    const dayAgo = Date.now() - 24*3600*1000;
    const recent = lineage.filter(r => new Date(r.created_at).getTime() >= dayAgo).length + 1; // +1 for original if not in lineage list
    if (recent >= 6) return json(res,429,{error:'rate_limited'});
    // Cooldown: last request must be older than cooldown
    const last = lineage.sort((a,b)=> new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] || original;
    if (cooldown > 0 && Date.now() - new Date(last.created_at).getTime() < cooldown*1000) {
      return json(res,429,{error:'cooldown'});
    }
    // Create new request reusing action/meta; treat params hashed from redacted_params (no original full params stored)
    const token = crypto.randomUUID();
    const nowMs = Date.now();
    const timeoutSec = evalResult.timeoutSec;
    const expiresAt = new Date(nowMs + timeoutSec * 1000).toISOString();
    let escalateAt: string | undefined;
    if (evalResult.escalation) {
      escalateAt = new Date(nowMs + (timeoutSec - evalResult.escalation.escalateBeforeSec) * 1000).toISOString();
    }
    const allowedIds = [
      ...(evalResult.policy.approvers.allowSlackIds || []),
  ...(currentPolicy?.defaults?.superApprovers || [])
    ];
    const hash = crypto.createHash('sha256').update(JSON.stringify(original.redacted_params)).digest('hex');
    const rec = await Store.createRequest({
      token,
      action: original.action,
      payload_hash: hash,
      redacted_params: original.redacted_params,
      meta: original.meta,
      status: original.required_personas.length ? 'awaiting_personas' : 'ready_for_approval',
      min_approvals: evalResult.minApprovals,
      approvals_count: 0,
      required_personas: evalResult.requiredPersonas,
      persona_state: Object.fromEntries(evalResult.requiredPersonas.map(p=>[p,'pending'])),
      allowed_approver_ids: Array.from(new Set(allowedIds)),
      expires_at: expiresAt,
      escalate_at: escalateAt,
      escalation_channel: evalResult.escalation?.escalationChannel,
      escalation_fired: false,
      created_at: new Date().toISOString(),
      policy_hash: evalResult.policy_hash,
        lineage_id: lineageId,
        allow_param_overrides: evalResult.overrides.allow,
        override_keys: evalResult.overrides.keys
    });
  audit('request_rerequested',{ new_id: rec.id, lineage_id: lineageId, actor });
  incCounter('approval_requests_total',{ action: rec.action });
    if (evalResult.channel) {
      postRequestMessage(rec, evalResult.channel).then(async ids => {
        await Store.setSlackMessage(rec.id, ids.channel, ids.ts);
      }).catch(err => audit('slack_post_error',{error:String(err)}));
    }
    span.setAttribute?.('request_id', rec.id);
    return json(res,200,{ token, requestId: rec.id, lineageId, status: rec.status, expiresAt });
    });
  }
  if (req.method === 'POST' && req.url === '/api/guard/request') {
    return withSpan('request.create', async span => {
    // Rate limit by remote address
    const ip = (req.socket.remoteAddress || 'unknown').replace('::ffff:','');
    if (!rateLimitAllowed(ip)) {
      incCounter('security_events_total',{ type:'rate_limited' });
      return json(res,429,{error:'rate_limited'});
    }
    const body = await readBody(req);
    let parsed; try { parsed = CreateRequestInputSchema.parse(JSON.parse(body)); } catch (e:any) { return json(res,400,{error:'invalid_payload',details:e.message}); }
  const currentPolicy = getPolicy();
  const evalResult = currentPolicy ? evaluate(parsed.action, currentPolicy) : undefined;
    if (!evalResult) return json(res,403,{error:'policy_denied'});
    span.setAttribute?.('action', parsed.action);
    const token = crypto.randomUUID();
    const nowMs = Date.now();
    const expiresAt = new Date(nowMs + evalResult.timeoutSec * 1000).toISOString();
    let escalateAt: string | undefined; let escalationChannel: string | undefined;
    if (evalResult.escalation) {
      escalateAt = new Date(nowMs + (evalResult.timeoutSec - evalResult.escalation.escalateBeforeSec) * 1000).toISOString();
      escalationChannel = evalResult.escalation.escalationChannel || undefined;
    }
    const status: RequestStatus = evalResult.requiredPersonas.length ? 'awaiting_personas' : 'ready_for_approval';
    const hash = crypto.createHash('sha256').update(JSON.stringify(parsed.params)).digest('hex');
    const redacted = redactParams(parsed.params, evalResult.redaction);
    const allowedIds = [
      ...(evalResult.policy.approvers.allowSlackIds || []),
  ...(currentPolicy?.defaults?.superApprovers || [])
    ];
  const rec = await Store.createRequest({
      token,
      action: parsed.action,
      payload_hash: hash,
      redacted_params: redacted,
      meta: parsed.meta,
      status,
      min_approvals: evalResult.minApprovals,
      approvals_count: 0,
      required_personas: evalResult.requiredPersonas,
      persona_state: Object.fromEntries(evalResult.requiredPersonas.map(p=>[p,'pending'])),
      allowed_approver_ids: Array.from(new Set(allowedIds)),
      expires_at: expiresAt,
      escalate_at: escalateAt,
      escalation_channel: escalationChannel,
      escalation_fired: false,
      created_at: new Date().toISOString(),
      policy_hash: evalResult.policy_hash,
      allow_param_overrides: evalResult.overrides.allow,
      override_keys: evalResult.overrides.keys
    });
    if (evalResult.channel) {
      postRequestMessage(rec, evalResult.channel).then(async ids => {
        await Store.setSlackMessage(rec.id, ids.channel, ids.ts);
      }).catch(err => audit('slack_post_error',{error:String(err)}));
    }
  audit('request_created',{id:rec.id, action:rec.action});
  incCounter('approval_requests_total',{ action: rec.action });
  // Fire any SSE listeners waiting on this token
  // (Token is only known to creator, but ensure consistency if listener attached quickly)
  // We cannot map token->id easily here, emit by attempting emitState via token
  // minimal overhead
  // dynamic import to avoid cycle
  // note: emitState already guards missing
  import('./sse.js').then(m => m.emitState(rec.token)).catch(()=>{});
    span.setAttribute?.('request_id', rec.id);
    return json(res,200,{ token, requestId: rec.id, status: rec.status, expiresAt, policy: { minApprovals: rec.min_approvals, requiredPersonas: rec.required_personas, timeoutSec: evalResult.timeoutSec } });
    });
  }
  if (req.url?.startsWith('/api/guard/wait-sse')) {
    if (req.method === 'GET') {
      const url = new URL(req.url,'http://localhost');
      const token = url.searchParams.get('token');
      if(!token) { res.writeHead(400); return res.end('missing token'); }
      const record = await Store.getByToken(token);
      if(!record) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200,{
        'Content-Type':'text/event-stream',
        'Cache-Control':'no-cache',
        Connection:'keep-alive'
      });
      addListener(token, res);
      // immediate state event
      await emitState(token);
      return; // connection held open
    }
  }
  if (req.url?.startsWith('/api/guard/wait')) {
    if (req.method === 'GET') {
      const url = new URL(req.url,'http://localhost');
      const token = url.searchParams.get('token'); if(!token) return json(res,400,{error:'missing_token'});
      const record = await Store.getByToken(token); if(!record) return json(res,404,{error:'not_found'});
      // Simple long-poll fallback rather than SSE for stub
  if(['approved','denied','expired'].includes(record.status)) return json(res,200,await terminalAsync(record));
      setTimeout(()=>{
        Promise.resolve(Store.getByToken(token)).then(async latest => {
          if (latest) json(res,200,await terminalAsync(latest)); else json(res,404,{error:'not_found'});
        });
      }, 2500);
      return;
    }
    if (req.method === 'POST') {
  const body = await readBody(req); let parsed; try { parsed = WaitRequestInputSchema.parse(JSON.parse(body)); } catch(e:any){ return json(res,400,{error:'invalid_payload'});} const record = await Store.getByToken(parsed.token); if(!record) return json(res,404,{error:'not_found'}); return json(res,200,await terminalAsync(record));
    }
  }
  if (req.method === 'POST' && req.url === '/api/slack/interactions') {
    return withSpan('slack.interaction', async span => {
    // Parse form-encoded body
    const rawBody = await readBody(req);
    const params = new URLSearchParams(rawBody);
    const payload = params.get('payload');
    if(!payload) { return json(res,400,{error:'missing_payload'}); }
    // Verify signature
    const ts = req.headers['x-slack-request-timestamp'] as string || '';
    const sig = req.headers['x-slack-signature'] as string || '';
    const signingSecret = process.env.SLACK_SIGNING_SECRET || '';
    if(!verifySlackSignature(signingSecret, rawBody, ts, sig)) { incCounter('security_events_total',{ type:'bad_signature' }); span.setAttribute?.('error','bad_signature'); return json(res,400,{error:'bad_signature'}); }
    // Enforce timestamp skew (±300s)
    const nowSec = Math.floor(Date.now()/1000);
    const tsNum = Number(ts);
    if (!tsNum || Math.abs(nowSec - tsNum) > 300) { incCounter('security_events_total',{ type:'stale_signature' }); span.setAttribute?.('error','stale_signature'); return json(res,400,{error:'stale_signature'}); }
    // Replay detection
    if (markAndCheckReplay(sig, ts)) { incCounter('security_events_total',{ type:'replay' }); span.setAttribute?.('error','replay'); return json(res,400,{error:'replay_detected'}); }
    let parsed; try { parsed = JSON.parse(payload); } catch { return json(res,400,{error:'invalid_json'}); }
    // Handle modal submission
    if (parsed.type === 'view_submission' && parsed.view?.callback_id === 'override_submit') {
      span.updateName?.('slack.override_submit');
      const metaRaw = parsed.view.private_metadata;
      let meta: any = {}; try { meta = JSON.parse(metaRaw);} catch {}
      const requestId = meta.request_id;
      const record = await Store.getById(requestId);
      if(!record) return json(res,200,{});
      audit('override_stage',{ request_id: record.id, actor: parsed.user?.id, stage: 'loaded_record', status: record.status, count: record.approvals_count });
      span.setAttribute?.('request_id', record.id);
      span.setAttribute?.('action', record.action);
      const userId = parsed.user?.id as string;
      if(!record.allowed_approver_ids.includes(userId)) {
        audit('override_stage',{ request_id: record.id, actor: userId, stage: 'unauthorized' });
        return json(res,200,{ response_action:'errors', errors: { _:'Not authorized'} });
      }
      if(!record.allow_param_overrides || !record.override_keys?.length) {
        audit('override_stage',{ request_id: record.id, actor: userId, stage: 'overrides_disabled' });
        return json(res,200,{ response_action:'errors', errors: { _:'Overrides disabled'} });
      }
      const stateValues = parsed.view.state?.values || {};
      const overrides: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      for (const key of record.override_keys) {
        const block = stateValues[`ov_${key}`];
        const valObj = block?.value || block?.['value'];
        const entry = block?.value || Object.values(block||{})[0];
        const v = entry?.value;
        if (typeof v === 'string' && v !== String((record.redacted_params as any)[key] ?? '')) {
          // Tentative value assignment (coerce number if numeric-like)
          let val: any = v;
          if (/^-?\d+(?:\.\d+)?$/.test(v)) {
            const num = Number(v);
            if (!Number.isNaN(num)) val = num;
          }
          overrides[key] = val;
          before[key] = (record.redacted_params as any)[key];
        }
      }
      audit('override_stage',{ request_id: record.id, actor: userId, stage: 'parsed_overrides', changed: Object.keys(overrides).length });
      const maxKeys = process.env.OVERRIDE_MAX_KEYS ? Number(process.env.OVERRIDE_MAX_KEYS) : undefined;
      if (maxKeys !== undefined && Object.keys(overrides).length > maxKeys) {
        audit('override_rejected',{ request_id: record.id, actor: userId, changed_keys: Object.keys(overrides), reason: 'limit_exceeded', limit: maxKeys });
        incCounter('override_rejections_total',{ action: record.action, reason: 'limit_exceeded' });
        incCounter('param_overrides_total',{ action: record.action, outcome: 'rejected' });
        return json(res,200,{ response_action:'errors', errors:{ _ : `Too many changes (max ${maxKeys})` } });
      }
      const charLimit = process.env.OVERRIDE_MAX_CHARS ? Number(process.env.OVERRIDE_MAX_CHARS) : undefined;
      if (charLimit !== undefined) {
        const size = totalOverrideCharSize(overrides);
        if (size > charLimit) {
          audit('override_rejected',{ request_id: record.id, actor: userId, changed_keys: Object.keys(overrides), reason: 'diff_size_exceeded', size, limit: charLimit });
          incCounter('override_rejections_total',{ action: record.action, reason: 'diff_size_exceeded' });
          incCounter('param_overrides_total',{ action: record.action, outcome: 'rejected' });
          return json(res,200,{ response_action:'errors', errors:{ _ : `Combined override size ${size} > limit ${charLimit}` } });
        }
      }
      // Schema validation (if schema for action exists)
      const schemaResult = validateOverrides(record.action, overrides);
      if (!schemaResult.ok) {
        audit('override_rejected',{ request_id: record.id, actor: userId, changed_keys: Object.keys(overrides), reason: 'schema_validation', errors: schemaResult.errors });
        incCounter('override_rejections_total',{ action: record.action, reason: 'schema_validation' });
        incCounter('param_overrides_total',{ action: record.action, outcome: 'rejected' });
        return json(res,200,{ response_action:'errors', errors:{ _ : `Schema validation failed: ${schemaResult.errors.slice(0,3).join('; ')}` } });
      }
      audit('override_stage',{ request_id: record.id, actor: userId, stage: 'validated', changed: Object.keys(overrides).length });
      const debug = process.env.APPROVAL_DEBUG === '1';
      if (debug) {
        try {
          const preList = (Store.approvalsFor as any)(record.id);
          audit('override_pre_approval_state', { request_id: record.id, actor: userId, status: record.status, count: record.approvals_count, list_len: Array.isArray(preList)? preList.length: undefined });
        } catch {/* ignore */}
      }
      // Apply overrides to redacted_params and recompute payload_hash BEFORE approval so approval sees final params
      const newParams = { ...record.redacted_params, ...overrides };
      record.redacted_params = newParams;
      record.payload_hash = crypto.createHash('sha256').update(JSON.stringify(newParams)).digest('hex');
      audit('override_stage',{ request_id: record.id, actor: userId, stage: 'applied_overrides' });
      // Approve immediately (treat like approval with overrides). Any approvals_count anomaly will be recomputed inside applyApproval
      const approval = applyApproval(record, userId);
      audit('override_stage',{ request_id: record.id, actor: userId, stage: 'approval_returned', ok: approval.ok });
      if (!approval.ok) {
        return json(res,200,{ response_action:'errors', errors:{ _ : errorMessage(approval.error) } });
      }
      if (debug) {
        try {
          const postList = (Store.approvalsFor as any)(record.id);
          audit('override_post_approval_state', { request_id: record.id, actor: userId, status: record.status, count: record.approvals_count, list_len: Array.isArray(postList)? postList.length: undefined });
        } catch {/* ignore */}
      }
      const diff: Record<string,{ before: unknown; after: unknown }> = {};
      for (const k of Object.keys(overrides)) diff[k] = { before: before[k], after: overrides[k] };
      audit('override_applied',{ request_id: record.id, actor: userId, overrides: Object.keys(overrides), diff });
  incCounter('param_overrides_total',{ action: record.action, outcome: 'applied' });
      broadcastForRequestId(record.id);
      try { await updateRequestMessage(record); } catch {}
      return json(res,200,{});
    }
    // Button/action interactions
    const action = parsed.actions?.[0];
    if(!action) return json(res,200,{});
    const actionId = action.action_id as string;
    const requestId = action.value as string;
    const userId = parsed.user?.id as string;
  let record = await Store.getById(requestId);
    if(!record) return json(res,200,{});
    span.setAttribute?.('request_id', record.id);
    span.setAttribute?.('action', record.action);
    let result; let personaChanged = false;
    if (actionId === 'approve') result = applyApproval(record, userId);
    else if (actionId === 'deny') result = applyDeny(record, userId);
    else if (actionId === 'approve_edit') {
      span.updateName?.('slack.approve_edit');
      if(!record.allow_param_overrides || !record.override_keys?.length) {
        return json(res,200,{ response_type:'ephemeral', text: 'Overrides not enabled for this action.' });
      }
      if(!record) return json(res,200,{});
      const blocks = record!.override_keys.map(k => ({
        type: 'input',
        block_id: `ov_${k}`,
        label: { type: 'plain_text', text: k },
        element: { type: 'plain_text_input', action_id: 'value', initial_value: String((record!.redacted_params as any)[k] ?? '') }
      }));
      try {
        await slackClient.views.open({
          trigger_id: parsed.trigger_id,
          view: {
            type: 'modal',
            callback_id: 'override_submit',
            private_metadata: JSON.stringify({ request_id: record.id }),
            title: { type: 'plain_text', text: 'Param Overrides' },
            submit: { type: 'plain_text', text: 'Apply & Approve' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks
          }
        });
      } catch (e) {
        audit('slack_modal_error',{ error:String(e), request_id: record.id });
        return json(res,200,{ response_type:'ephemeral', text: 'Failed to open override modal.' });
      }
      return json(res,200,{});
    }
    else if (actionId.startsWith('persona_ack:')) {
      span.updateName?.('slack.persona_ack');
      const persona = actionId.split(':')[1];
      if (record.required_personas.includes(persona) && record.persona_state[persona] === 'pending') {
        await Store.updatePersonaState(record.id, persona, 'ack', userId);
        incCounter('persona_ack_total',{ action: record.action, persona });
        personaChanged = true;
        // Re-fetch canonical in case updatePersonaState returned/modified a different stored instance
        try {
          const fresh = await Store.getById(record.id);
            if (fresh && fresh !== record) {
              audit('persona_canonical_adopted',{ request_id: record.id, actor: userId, persona, status_before: record.status, status_canonical: fresh.status });
              record = fresh;
            }
        } catch {/* ignore */}
  if(!record) { return json(res,200,{}); }
  const allAck = record!.required_personas.every(p => record!.persona_state[p] === 'ack');
        if (allAck && record.status === 'awaiting_personas') {
          record.status = 'ready_for_approval';
          audit('persona_ack_ready',{ request_id: record.id, actor: userId, persona, status: record.status });
        }
        try { audit('persona_ack_stage',{ request_id: record.id, actor: userId, persona, state: record.persona_state[persona], all_ack: allAck, status: record.status }); } catch {/* ignore */}
      }
    }
    if (result && !result.ok) {
      return json(res,200,{ response_type:'ephemeral', text: errorMessage(result.error) });
    }
    if (result?.ok || personaChanged) {
      broadcastForRequestId(record.id);
      try { await updateRequestMessage(record); } catch (e) { audit('slack_update_error',{ error:String(e), request_id: record.id }); }
    }
    return json(res,200,{});
    });
  }
  // Slack view submissions (modal) share the same endpoint; payload.type === 'view_submission'
  if (req.method === 'POST' && req.url === '/api/slack/interactions') {
    // Already parsed above normally, but if we reach here and payload is a view_submission we process overrides
  }
  // Admin: policy reload endpoint (POST /api/admin/reload-policy)
  if (req.method === 'POST' && req.url === '/api/admin/reload-policy') {
    return withSpan('admin.reload_policy', async span => {
      const adminToken = process.env.ADMIN_TOKEN;
      if (adminToken) {
        const provided = req.headers['x-admin-token'];
        if (provided !== adminToken) { res.writeHead(401); return res.end('unauthorized'); }
      }
      try {
        const pf = reloadPolicy();
        audit('policy_reloaded', { source: 'api', actions: Object.keys(pf.actions||{}).length, hash: (pf as any).policy_hash });
        incCounter('policy_reloads_total',{ source: 'api' });
        span.setAttribute?.('actions_count', Object.keys(pf.actions||{}).length);
        return json(res,200,{ ok:true, actions:Object.keys(pf.actions||{}).length, hash: (pf as any).policy_hash });
      } catch (e:any) {
        audit('policy_reload_failed',{ source:'api', error:String(e) });
        span.setAttribute?.('error','reload_failed');
        return json(res,500,{ error:'reload_failed', detail: String(e) });
      }
    });
  }
  if (req.method === 'GET' && req.url === '/readyz') {
    try {
      const policy = getPolicy();
      const policyOk = !!policy;
      // Basic store check: attempt a lightweight call if available
      let storeOk = true;
      let storeBackend: string = (process.env.STORE_BACKEND === 'redis') ? 'redis' : 'memory';
      if (storeBackend === 'redis') {
        try {
          if (Store.listOpenRequests) {
            const resTest = await Promise.race([
              Promise.resolve(Store.listOpenRequests()),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 500))
            ]);
            if (!resTest) storeOk = true; // empty acceptable
          }
        } catch (e) {
          storeOk = false;
        }
      }
      const body = { status: (policyOk && storeOk) ? 'ok' : 'degraded', policy: policyOk ? 'loaded' : 'missing', store: storeOk ? 'ok' : 'error', backend: storeBackend };
      res.writeHead((policyOk && storeOk) ? 200 : 503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(body));
    } catch (e: any) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'error', error: e?.message || 'unknown' }));
    }
  }
  notFound(res);
  }

async function terminalAsync(rPromise: ReturnType<typeof Store.getByToken>): Promise<any> {
  const r = await rPromise as any;
  if(!r) return { status: 'expired' };
  const approvers = await Store.approvalsFor(r.id);
  return { status: r.status, approvers, decidedAt: r.decided_at };
}

function redactParams(params: Record<string,unknown>, redaction: { mode: string; keys: string[] }) {
  if (redaction.mode === 'all') return params;
  if (redaction.mode === 'allowlist') {
    return Object.fromEntries(Object.entries(params).map(([k,v]) => redaction.keys.includes(k) ? [k,v] : [k,'«redacted»']) );
  }
  if (redaction.mode === 'denylist') {
    return Object.fromEntries(Object.entries(params).map(([k,v]) => redaction.keys.includes(k) ? [k,'«redacted»'] : [k,v]) );
  }
  return {};
}

function readBody(req: http.IncomingMessage): Promise<string> { return new Promise(res => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>res(d)); }); }

// Iterator for local in-memory requests (helper for interactions handler)
// removed legacy requests() iterator after introducing direct Store.getById

function errorMessage(code: string): string {
  switch(code){
    case 'not_authorized': return 'You are not authorized to approve this request.';
    case 'duplicate': return 'You already approved this request.';
    case 'not_ready': return 'Request not ready for approval (persona gating).';
    default: return 'Unable to process interaction.';
  }
}

export function getServer() { return server; }
export function startServer(port?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      ensureServer();
      const p = port ?? Number(process.env.PORT || 3000);
      server.listen(p, () => {
        const addr = server.address();
        const actual = typeof addr === 'object' && addr ? addr.port : p;
        // eslint-disable-next-line no-console
        console.log(`Approval Service listening on :${actual}`);
        resolve(actual);
      });
    } catch (e) { reject(e); }
  });
}

// Auto-start only outside vitest (VITEST env var is set during tests)
if (!process.env.VITEST) {
  startServer();
  startScheduler();
  startRetentionSweeper();
}

// SIGHUP-triggered policy reload (Unix-friendly). Ignored on Windows if signal unsupported.
try {
  process.on('SIGHUP', () => {
    try {
      const pf = reloadPolicy();
      audit('policy_reloaded', { source: 'sighup', actions: Object.keys(pf.actions||{}).length, hash: (pf as any).policy_hash });
      incCounter('policy_reloads_total',{ source: 'sighup' });
    } catch (e) {
      audit('policy_reload_failed',{ source:'sighup', error:String(e) });
    }
  });
} catch {/* no-op */}
