import { LIMITS, type EventContext, type Metadata, type ObservabilityEvent } from '@fop/schema';
import { createId, currentPage, resolveSessionId } from './context.ts';
import { watchLifecycle } from './lifecycle.ts';
import { normalizeError, sanitizeMetadata, truncate } from './normalize.ts';
import { createPipeline } from './pipeline.ts';
import { createRateLimiter } from './rate-limit.ts';
import { createFetchTransport, type Transport } from './transport.ts';

interface BaseOptions {
  application: string;
  environment: string;
  release?: string;
  /** Default 20, capped at the schema's batch limit. */
  maxBatchSize?: number;
  /** Default 5000 ms. */
  flushIntervalMs?: number;
  /** Events buffered while the collector is unreachable. Default 500. */
  maxQueueSize?: number;
  /** Logs SDK-internal problems to the console. Off by default. */
  debug?: boolean;
}

/** Either a collector URL, or a custom transport for other destinations. */
export type ObservabilityOptions = BaseOptions &
  ({ endpoint: string; transport?: never } | { transport: Transport; endpoint?: never });

export interface Observability {
  captureError(error: unknown, metadata?: Metadata): void;
  track(name: string, metadata?: Metadata): void;
  /**
   * Sends buffered events now, unless delivery is paused (offline, or backing
   * off after the collector failed). Never rejects.
   */
  flush(): Promise<void>;
  /** Flushes, stops accepting events and removes browser listeners. Never rejects. */
  shutdown(): Promise<void>;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_QUEUE_SIZE = 500;
const ERROR_LIMIT = { max: 10, windowMs: 60_000 };

const NOOP: Observability = Object.freeze({
  captureError() {},
  track() {},
  flush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
});

export function createObservability(options: ObservabilityOptions): Observability {
  const problem = findConfigProblem(options);
  if (problem) {
    // A misconfigured SDK must not take the app down with it, but staying
    // silent would hide the misconfiguration, so this warns even without debug.
    console.warn(`[observability] disabled: ${problem}`);
    return NOOP;
  }

  const debug = (message: string, detail?: unknown) => {
    if (options.debug) console.warn(`[observability] ${message}`, ...(detail ? [detail] : []));
  };

  const pipeline = createPipeline({
    transport: options.transport ?? createFetchTransport(options.endpoint),
    maxBatchSize: Math.min(options.maxBatchSize ?? DEFAULT_BATCH_SIZE, LIMITS.maxEventsPerBatch),
    flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    maxQueueSize: options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
    onDrop: (count, reason) => debug(`dropped ${count} event(s): ${reason}`),
  });
  const errorLimiter = createRateLimiter(ERROR_LIMIT);
  const stopWatching = watchLifecycle({
    onExit: () => pipeline.flushOnExit(),
    onOnline: () => pipeline.resume(),
    onError: (error) => debug('lifecycle handler failed', error),
  });

  const base = {
    application: truncate(options.application, LIMITS.maxStringLength),
    environment: truncate(options.environment, LIMITS.maxStringLength),
    ...(options.release ? { release: truncate(options.release, LIMITS.maxStringLength) } : {}),
    sessionId: resolveSessionId(),
  };
  let closed = false;

  function context(metadata: unknown): EventContext {
    const clean = sanitizeMetadata(metadata);
    return {
      ...base,
      id: createId(),
      timestamp: Date.now(),
      page: truncate(currentPage(), LIMITS.maxUrlLength),
      ...(clean ? { metadata: clean } : {}),
    };
  }

  /**
   * Capture is synchronous but cheap (build an object, push it to an array);
   * serialization and network happen later, off the caller's path. Any failure
   * is contained here so it never reaches application code.
   */
  function emit(method: string, build: () => ObservabilityEvent | undefined): void {
    if (closed) return;
    try {
      const event = build();
      if (event) pipeline.enqueue(event);
    } catch (error) {
      debug(`${method} failed`, error);
    }
  }

  return {
    captureError(error, metadata) {
      emit('captureError', () => {
        const normalized = normalizeError(error);
        const decision = errorLimiter.check(`${normalized.name}: ${normalized.message}`);
        if (!decision.allowed) return undefined;
        // SDK key first, so it survives the metadata key limit.
        const enriched = decision.suppressed
          ? { suppressedOccurrences: decision.suppressed, ...metadata }
          : metadata;
        return {
          ...context(enriched),
          type: 'error',
          error: { source: 'manual', ...normalized },
        };
      });
    },
    track(name, metadata) {
      emit('track', () => {
        if (typeof name !== 'string' || name.length === 0) {
          debug('track() requires a non-empty name');
          return undefined;
        }
        return {
          ...context(metadata),
          type: 'custom',
          custom: { name: truncate(name, LIMITS.maxStringLength) },
        };
      });
    },
    flush() {
      return pipeline.flush();
    },
    shutdown() {
      closed = true;
      stopWatching();
      return pipeline.flush();
    },
  };
}

function findConfigProblem(options: unknown): string | undefined {
  if (typeof options !== 'object' || options === null) return 'options object is required';
  const { application, environment, endpoint, transport } = options as Record<string, unknown>;
  if (typeof application !== 'string' || !application) return '`application` is required';
  if (typeof environment !== 'string' || !environment) return '`environment` is required';
  if (transport === undefined && (typeof endpoint !== 'string' || !endpoint)) {
    return '`endpoint` or `transport` is required';
  }
  return undefined;
}
