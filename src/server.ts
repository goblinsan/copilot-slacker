import http from 'node:http';
import { CreateRequestInputSchema, WaitRequestInputSchema, RequestStatus, RequestStatusSchema } from './types.js';
import { loadPolicy, evaluate } from './policy.js';
import { Store } from './store.js';
import { postRequestMessage, verifySlackSignature, updateRequestMessage } from './slack.js';
import crypto from 'node:crypto';
import { audit } from './log.js';

const POLICY_PATH = process.env.POLICY_PATH || '.agent/policies/guards.yml';
const policyFile = loadPolicy(POLICY_PATH);

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function notFound(res: http.ServerResponse) { res.statusCode = 404; res.end('Not found'); }

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/healthz')) { res.end('ok'); return; }
  if (req.method === 'POST' && req.url === '/api/guard/request') {
    const body = await readBody(req);
    let parsed; try { parsed = CreateRequestInputSchema.parse(JSON.parse(body)); } catch (e:any) { return json(res,400,{error:'invalid_payload',details:e.message}); }
    const evalResult = evaluate(parsed.action, policyFile);
    if (!evalResult) return json(res,403,{error:'policy_denied'});
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + evalResult.timeoutSec * 1000).toISOString();
    const status: RequestStatus = evalResult.requiredPersonas.length ? 'awaiting_personas' : 'ready_for_approval';
    const hash = crypto.createHash('sha256').update(JSON.stringify(parsed.params)).digest('hex');
    const redacted = redactParams(parsed.params, evalResult.redaction);
    const rec = Store.createRequest({
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
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
      policy_hash: evalResult.policy_hash
    });
    if (evalResult.channel) {
      postRequestMessage(rec, evalResult.channel).then(ids => {
        Store.setSlackMessage(rec.id, ids.channel, ids.ts);
      }).catch(err => audit('slack_post_error',{error:String(err)}));
    }
    audit('request_created',{id:rec.id, action:rec.action});
    return json(res,200,{ token, requestId: rec.id, status: rec.status, expiresAt, policy: { minApprovals: rec.min_approvals, requiredPersonas: rec.required_personas, timeoutSec: evalResult.timeoutSec } });
  }
  if (req.url?.startsWith('/api/guard/wait')) {
    if (req.method === 'GET') {
      const url = new URL(req.url,'http://localhost');
      const token = url.searchParams.get('token'); if(!token) return json(res,400,{error:'missing_token'});
      const record = Store.getByToken(token); if(!record) return json(res,404,{error:'not_found'});
      // Simple long-poll fallback rather than SSE for stub
      if(['approved','denied','expired'].includes(record.status)) return json(res,200,terminal(record));
      setTimeout(()=>{
        const latest = Store.getByToken(token)!; // re-check
        json(res,200,terminal(latest));
      }, 2500);
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req); let parsed; try { parsed = WaitRequestInputSchema.parse(JSON.parse(body)); } catch(e:any){ return json(res,400,{error:'invalid_payload'});} const record = Store.getByToken(parsed.token); if(!record) return json(res,404,{error:'not_found'}); return json(res,200,terminal(record));
    }
  }
  if (req.method === 'POST' && req.url === '/api/slack/interactions') {
    // Parse form-encoded body
    const rawBody = await readBody(req);
    const params = new URLSearchParams(rawBody);
    const payload = params.get('payload');
    if(!payload) { return json(res,400,{error:'missing_payload'}); }
    // Verify signature
    const ts = req.headers['x-slack-request-timestamp'] as string || '';
    const sig = req.headers['x-slack-signature'] as string || '';
    const signingSecret = process.env.SLACK_SIGNING_SECRET || '';
    if(!verifySlackSignature(signingSecret, rawBody, ts, sig)) return json(res,400,{error:'bad_signature'});
    let parsed; try { parsed = JSON.parse(payload); } catch { return json(res,400,{error:'invalid_json'}); }
    const action = parsed.actions?.[0];
    if(!action) return json(res,200,{});
    const actionId = action.action_id;
    const requestId = action.value;
    const userId = parsed.user?.id;
    const record = [...requests()].find(r => r.id === requestId);
    if(!record) return json(res,200,{});
    if (actionId === 'approve') {
      if (record.status === 'ready_for_approval') {
        record.approvals_count += 1;
        if (record.approvals_count >= record.min_approvals) {
          record.status = 'approved'; record.decided_at = new Date().toISOString();
          audit('approved',{id:record.id, by:userId});
        }
        await updateRequestMessage(record);
      }
    } else if (actionId === 'deny') {
      if (!['approved','denied','expired'].includes(record.status)) {
        record.status = 'denied'; record.decided_at = new Date().toISOString();
        audit('denied',{id:record.id, by:userId});
        await updateRequestMessage(record);
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{}');
  }
  notFound(res);
});

function terminal(r: ReturnType<typeof Store.getByToken>): any {
  if(!r) return { status: 'expired' };
  return { status: r.status, approvers: [], decidedAt: r.decided_at };
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
function* requests() { // NOT FOR PROD: expose internal map
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const storeMod = require('./store.js');
  const map: Map<string, any> = storeMod?.Store?._requests || storeMod.requests || new Map();
  for (const r of (map as any).values()) yield r;
}

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Approval Service listening on :${PORT}`);
});
