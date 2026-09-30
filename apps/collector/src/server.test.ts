import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  SCHEMA_VERSION,
  type ErrorsResponse,
  type EventsResponse,
  type ObservabilityEvent,
  type OverviewResponse,
  type RequestsResponse,
} from '@fop/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollector } from './server.ts';
import { createMemoryStore } from './store.ts';
import { customEvent, errorEvent, requestEvent, T0 } from './test-utils.ts';

let server: Server;
let baseUrl: string;
let clock: number;

beforeEach(async () => {
  clock = T0 + 60_000;
  server = createCollector({
    store: createMemoryStore(),
    maxBodyBytes: 64 * 1024,
    now: () => clock,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function post(body: unknown, init: RequestInit = {}) {
  return fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    // What the SDK sends: text/plain to stay a CORS-simple request.
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

const batch = (events: unknown[], sentAt = clock) => ({
  schemaVersion: SCHEMA_VERSION,
  sentAt,
  events,
});

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

describe('POST /v1/events', () => {
  it('stores valid events and reports rejected ones by index', async () => {
    const response = await post(batch([customEvent(), { invalid: true }, errorEvent()]));

    expect(response.status).toBe(202);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toMatchObject({
      stored: 2,
      duplicates: 0,
      rejected: [{ index: 1, reason: expect.any(String) as string }],
    });
  });

  it('is idempotent: a retried batch is acknowledged without storing twice', async () => {
    const events = [customEvent(), customEvent()];

    await post(batch(events));
    const retry = await post(batch(events));

    expect(await retry.json()).toMatchObject({ stored: 0, duplicates: 2 });
    expect((await get<EventsResponse>(`/v1/events?from=${T0 - 1}`)).total).toBe(2);
  });

  it.each([
    ['malformed JSON', '{not json', 'valid JSON'],
    ['an unsupported schema version', { ...batch([]), schemaVersion: 99 }, 'schemaVersion'],
  ])('rejects %s with 400 so the SDK does not retry', async (_label, body, reason) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(reason);
  });

  it('rejects oversized bodies with 413', async () => {
    const response = await post('x'.repeat(65 * 1024));
    expect(response.status).toBe(413);
  });

  it('answers CORS preflight', async () => {
    const response = await fetch(`${baseUrl}/v1/events`, { method: 'OPTIONS' });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });
});

describe('query API', () => {
  async function seed(events: ObservabilityEvent[]) {
    expect((await post(batch(events))).status).toBe(202);
  }

  it('GET /v1/overview aggregates the default window', async () => {
    await seed([
      errorEvent({}, { sessionId: 'a' }),
      customEvent('x', { sessionId: 'b' }),
      requestEvent({ status: 500, outcome: 'http_error' }, { sessionId: 'b' }),
    ]);

    const overview = await get<OverviewResponse>('/v1/overview');

    expect(overview.window.to).toBe(clock);
    expect(overview.totals).toMatchObject({ events: 3, errors: 1, requests: 1, failedRequests: 1 });
    expect(overview.errorRate).toBe(0.5);
  });

  it('GET /v1/errors and /v1/requests return groups', async () => {
    await seed([errorEvent(), errorEvent(), requestEvent({ url: 'https://api.test/pokemon/7' })]);

    const errors = await get<ErrorsResponse>('/v1/errors');
    const requests = await get<RequestsResponse>('/v1/requests');

    expect(errors.groups).toMatchObject([{ count: 2 }]);
    expect(requests.groups).toMatchObject([{ endpoint: 'https://api.test/pokemon/:id', count: 1 }]);
  });

  it('GET /v1/events filters and limits', async () => {
    await seed([errorEvent(), customEvent(), customEvent('x', { application: 'other' })]);

    const page = await get<EventsResponse>('/v1/events?type=custom&application=demo-app&limit=10');

    expect(page.total).toBe(1);
    expect(page.items).toMatchObject([{ type: 'custom', application: 'demo-app' }]);
  });

  it.each([
    ['/v1/events?type=click', 'type'],
    ['/v1/events?limit=0', 'limit'],
    ['/v1/overview?from=10&to=5', 'from'],
    ['/v1/overview?from=abc', 'from'],
  ])('rejects invalid query %s', async (path, reason) => {
    const response = await fetch(`${baseUrl}${path}`);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(reason);
  });
});

describe('routing', () => {
  it('returns 404 for unknown paths and 405 with Allow for wrong methods', async () => {
    expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);

    const response = await fetch(`${baseUrl}/v1/overview`, { method: 'DELETE' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });
});
