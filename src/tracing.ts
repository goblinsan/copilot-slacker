/**
 * Tracing initialization (optional)
 *
 * Enabled when TRACING_ENABLED=true. Exporters:
 *  - console (default): logs spans to stdout
 *  - none: initialize API no-op (explicit)
 *
 * Future: OTLP exporter (grpc/http) when env OTLP_ENDPOINT provided.
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { Resource } from '@opentelemetry/resources';

let tracerProvider: NodeTracerProvider | undefined;
let memorySpans: any[] | undefined;

export function initTracing() {
  if (tracerProvider || process.env.TRACING_ENABLED !== 'true') return;
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
  tracerProvider = new NodeTracerProvider({
    resource: new Resource({
      'service.name': 'approval-service'
    })
  });
  const exporterType = process.env.TRACING_EXPORTER || 'console';
  if (exporterType === 'console') {
    const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-node');
    tracerProvider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  } else if (exporterType === 'memory') {
    memorySpans = [];
    class MemoryExporter {
      export(batch: any, resultCallback: any){
        // batch is array of spans
        for (const s of batch) memorySpans!.push(s);
        resultCallback && resultCallback();
      }
      shutdown() { return Promise.resolve(); }
    }
    tracerProvider.addSpanProcessor(new SimpleSpanProcessor(new MemoryExporter()));
  } else if (exporterType === 'none') {
    // no exporter
  }
  tracerProvider.register();
}

export function getTracer() {
  return require('@opentelemetry/api').trace.getTracer('approval-service');
}

export async function shutdownTracing() {
  if (tracerProvider) await tracerProvider.shutdown().catch(()=>{});
}

export async function withSpan<T>(name: string, fn: (span: any) => Promise<T> | T): Promise<T> {
  const tracer = getTracer();
  return await tracer.startActiveSpan(name, async (span: any) => {
    try {
      const res = await fn(span);
      span.end();
      return res;
    } catch (e:any) {
      span.recordException?.(e);
      span.setStatus?.({ code: 2, message: String(e) });
      span.end();
      throw e;
    }
  });
}

// Test helper (only populated when TRACING_EXPORTER=memory)
export function getCollectedSpans(): any[] { return memorySpans || []; }
