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
import { InMemorySpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { Resource } from '@opentelemetry/resources';

let tracerProvider: NodeTracerProvider | undefined;
let memoryExporter: InMemorySpanExporter | undefined;

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
    memoryExporter = new InMemorySpanExporter();
    tracerProvider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
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
export function getCollectedSpans(): ReadableSpan[] { return memoryExporter ? memoryExporter.getFinishedSpans() : []; }
