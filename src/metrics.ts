/**
 * Minimal in-memory metrics with Prometheus text exposition.
 * Supports labeled counters (action label) and a single decision latency histogram.
 */

type LabelSet = { [k: string]: string };
interface Counter { name: string; help?: string; values: Map<string, number>; }
interface Histogram { name: string; help?: string; buckets: number[]; counts: number[]; sum: number; count: number; labels: LabelSet; }

const counters: Record<string, Counter> = {};
// decision latency now multi-dimensional (action, outcome)
const decisionLatencyHists: Histogram[] = [];

function labelKey(labels: LabelSet) { return Object.keys(labels).sort().map(k=>`${k}=${labels[k]}`).join(','); }

export function defineCounter(name: string, help?: string) {
	if (!counters[name]) counters[name] = { name, help, values: new Map() };
}

export function incCounter(name: string, labels: LabelSet, delta = 1) {
	const c = counters[name]; if(!c) return;
	const key = labelKey(labels);
	c.values.set(key, (c.values.get(key)||0) + delta);
}

export function observeDecisionLatency(seconds: number, labels: LabelSet) {
	const bucketBoundaries = [0.1,0.25,0.5,1,2,5,10,30,60];
	const key = labelKey(labels);
	let h = decisionLatencyHists.find(x => labelKey(x.labels) === key);
	if(!h){
		h = { name: 'decision_latency_seconds', help: 'Time from request create to terminal state', labels, buckets: bucketBoundaries, counts: new Array(bucketBoundaries.length+1).fill(0), sum:0, count:0 };
		decisionLatencyHists.push(h);
	}
	h.sum += seconds; h.count += 1;
	let idx = h.buckets.findIndex(b => seconds <= b);
	if (idx === -1) idx = h.buckets.length;
	h.counts[idx] += 1;
}

export async function serializePrometheus(pendingGaugeProvider?: () => Promise<Record<string, number>>): Promise<string> {
	const lines: string[] = [];
	// Counters
	for (const c of Object.values(counters)) {
		if (c.help) lines.push(`# HELP ${c.name} ${c.help}`);
		lines.push(`# TYPE ${c.name} counter`);
		for (const [k,v] of c.values.entries()) {
			const labels = k.split(',').filter(Boolean).map(pair => pair.split('='));
			const labelStr = labels.length ? '{'+labels.map(([lk,lv])=>`${lk}="${lv}"`).join(',')+'}' : '';
			lines.push(`${c.name}${labelStr} ${v}`);
		}
	}
	// Histogram(s)
	if (decisionLatencyHists.length) {
		lines.push(`# HELP decision_latency_seconds Time from request create to terminal state`);
		lines.push(`# TYPE decision_latency_seconds histogram`);
		for (const h of decisionLatencyHists) {
			let cumulative = 0;
			for (let i=0;i<h.buckets.length;i++) {
				cumulative += h.counts[i];
				lines.push(`${h.name}_bucket{${formatLabelSet({...h.labels, le:String(h.buckets[i])})}} ${cumulative}`);
			}
			cumulative += h.counts[h.buckets.length];
			lines.push(`${h.name}_bucket{${formatLabelSet({...h.labels, le:'+Inf'})}} ${cumulative}`);
			lines.push(`${h.name}_sum{${formatLabelSet(h.labels)}} ${h.sum}`);
			lines.push(`${h.name}_count{${formatLabelSet(h.labels)}} ${h.count}`);
		}
	}
	// Pending gauge (dynamic)
	if (pendingGaugeProvider) {
		const gauges = await pendingGaugeProvider();
		lines.push('# TYPE pending_requests gauge');
		for (const [action,count] of Object.entries(gauges)) {
			lines.push(`pending_requests{action="${action}"} ${count}`);
		}
	}
	return lines.join('\n') + '\n';
}

// Define core counters on import
defineCounter('approval_requests_total','Number of guard requests created');
defineCounter('approvals_total','Approvals leading to terminal state');
defineCounter('denies_total','Denies leading to terminal state');
defineCounter('expired_total','Expired requests');
defineCounter('escalations_total','Escalation notices fired');
defineCounter('security_events_total','Security related events (type label)');
defineCounter('persona_ack_total','Persona acknowledgments (labels: action, persona)');
defineCounter('param_overrides_total','Parameter overrides (labels: action, outcome)');
defineCounter('override_rejections_total','Override rejections (labels: action, reason)');
defineCounter('policy_reloads_total','Policy reload events (labels: source)');
defineCounter('archived_requests_total','Requests archived (labels: reason)');
defineCounter('purged_requests_total','Requests purged (labels: reason)');
defineCounter('request_archive_failures_total','Archive write failures (labels: reason)');
// no pre-allocation of latency histogram; created lazily per label set

export function resetAllMetrics(){ for (const c of Object.values(counters)) c.values.clear(); decisionLatencyHists.splice(0, decisionLatencyHists.length); }

function formatLabelSet(labels: LabelSet): string { return Object.entries(labels).map(([k,v])=>`${k}="${v}"`).join(','); }
