import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { EVENT_TYPES, validateBatch, type EventQuery, type EventType } from '@fop/schema';
import {
  buildErrorGroups,
  buildEventsPage,
  buildOverview,
  buildRequestGroups,
} from './aggregate.ts';
import { toStoredEvents } from './ingest.ts';
import type { EventStore } from './store.ts';

export interface CollectorOptions {
  store: EventStore;
  /** 100 events with maximum-size stacks fit comfortably under 1 MiB. */
  maxBodyBytes?: number;
  /** Window used by queries that omit `from`. */
  defaultWindowMs?: number;
  now?: () => number;
}

type Handler = (request: IncomingMessage, url: URL) => Promise<Reply> | Reply;
interface Reply {
  status: number;
  body?: unknown;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createCollector({
  store,
  maxBodyBytes = 1024 * 1024,
  defaultWindowMs = 60 * 60 * 1000,
  now = Date.now,
}: CollectorOptions): Server {
  const routes = new Map<string, Handler>([
    ['POST /v1/events', ingest],
    ['GET /v1/health', () => ({ status: 200, body: { status: 'ok' } })],
    [
      'GET /v1/events',
      (_request, url) => {
        const { query, window } = parseQuery(url);
        const limit = parseInteger(url, 'limit', { min: 1, max: 500 }) ?? 100;
        return { status: 200, body: buildEventsPage(store.query(query), window, limit) };
      },
    ],
    [
      'GET /v1/overview',
      (_request, url) => {
        const { query, window } = parseQuery(url);
        return { status: 200, body: buildOverview(store.query(query), window) };
      },
    ],
    [
      'GET /v1/errors',
      (_request, url) => {
        const { query, window } = parseQuery(url);
        const events = store.query({ ...query, type: 'error' });
        return { status: 200, body: buildErrorGroups(events, window) };
      },
    ],
    [
      'GET /v1/requests',
      (_request, url) => {
        const { query, window } = parseQuery(url);
        const events = store.query({ ...query, type: 'request' });
        return { status: 200, body: buildRequestGroups(events, window) };
      },
    ],
  ]);

  async function ingest(request: IncomingMessage): Promise<Reply> {
    const receivedAt = now();
    const raw = await readBody(request, maxBodyBytes);

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'body must be valid JSON');
    }

    const batch = validateBatch(payload);
    // 4xx tells the SDK not to retry: resending the same payload cannot succeed.
    if (!batch.ok) throw new HttpError(400, batch.reason);

    const { inserted, duplicates } = store.append(
      toStoredEvents(batch.accepted, batch.sentAt, receivedAt),
    );
    return { status: 202, body: { stored: inserted, duplicates, rejected: batch.rejected } };
  }

  function parseQuery(url: URL) {
    const to = parseInteger(url, 'to', { min: 0 }) ?? now();
    const from = parseInteger(url, 'from', { min: 0 }) ?? to - defaultWindowMs;
    if (from >= to) throw new HttpError(400, '`from` must be before `to`');

    const type = url.searchParams.get('type');
    if (type !== null && !EVENT_TYPES.includes(type as EventType)) {
      throw new HttpError(400, `type must be one of: ${EVENT_TYPES.join(', ')}`);
    }

    const query: EventQuery = { from, to };
    const application = url.searchParams.get('application');
    const environment = url.searchParams.get('environment');
    if (application) query.application = application;
    if (environment) query.environment = environment;
    if (type) query.type = type as EventType;
    return { query, window: { from, to } };
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Ingest is public by nature (like a Sentry DSN) and requests carry no
    // credentials, so a wildcard origin is safe and lets any app report.
    response.setHeader('Access-Control-Allow-Origin', '*');
    // Not CORS-safelisted: without this the SDK cannot read it cross-origin.
    response.setHeader('Access-Control-Expose-Headers', 'Retry-After');

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', 'http://collector.local');

    try {
      const handler = routes.get(`${request.method} ${url.pathname}`);
      if (!handler) {
        const allowed = [...routes.keys()]
          .filter((key) => key.endsWith(` ${url.pathname}`))
          .map((key) => key.split(' ')[0]);
        if (allowed.length === 0) throw new HttpError(404, 'not found');
        response.setHeader('Allow', allowed.join(', '));
        throw new HttpError(405, 'method not allowed');
      }
      const reply = await handler(request, url);
      sendJson(response, reply.status, reply.body);
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 413) response.setHeader('Connection', 'close');
        sendJson(response, error.status, { error: error.message });
      } else {
        console.error('[collector] unhandled error', error);
        sendJson(response, 500, { error: 'internal error' });
      }
    }
  }

  const server = createServer((request, response) => void handle(request, response));
  // Bound how long a slow client can hold a connection open.
  server.requestTimeout = 10_000;
  return server;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

/**
 * Accepts any content type: the SDK sends `text/plain` on purpose to avoid
 * CORS preflights, and `sendBeacon` cannot set JSON headers anyway.
 */
async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const declared = Number(request.headers['content-length']);
  if (declared > maxBytes) throw new HttpError(413, `body exceeds ${maxBytes} bytes`);

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    // Keep draining without buffering so the response can still be written.
    if (size <= maxBytes) chunks.push(chunk);
  }
  if (size > maxBytes) throw new HttpError(413, `body exceeds ${maxBytes} bytes`);
  return Buffer.concat(chunks).toString('utf8');
}

function parseInteger(
  url: URL,
  name: string,
  { min, max = Number.MAX_SAFE_INTEGER }: { min: number; max?: number },
): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
