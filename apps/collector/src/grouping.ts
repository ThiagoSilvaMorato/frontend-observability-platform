import { createHash } from 'node:crypto';

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_ANYWHERE = new RegExp(UUID_PATTERN, 'gi');
const ID_SEGMENT = new RegExp(`^(\\d+|${UUID_PATTERN}|[0-9a-f]{16,})$`, 'i');

/**
 * Groups occurrences of "the same" error. Messages often embed variable data
 * (ids, counts, addresses), and bundlers put content hashes in file names, so
 * both are normalized before hashing — otherwise every occurrence or every
 * deploy would open a new group.
 */
export function errorFingerprint(error: { name: string; message: string; stack?: string }): string {
  const message = error.message
    .replace(UUID_ANYWHERE, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\d+(\.\d+)?/g, '<n>');
  const key = [error.name, message, topFrame(error.stack) ?? ''].join('|');
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/**
 * First stack frame (Chrome `at fn (file:1:2)` or Firefox `fn@file:1:2`),
 * without line/column, query string or build hash.
 */
export function topFrame(stack: string | undefined): string | undefined {
  const frame = stack?.split('\n').find((line) => /:\d+:\d+\)?\s*$/.test(line));
  return frame
    ?.trim()
    .replace(/:\d+:\d+(\)?)\s*$/, '$1')
    .replace(/\?[^):]*/, '')
    .replace(/[-.][A-Za-z0-9_]{8}(?=\.m?js)/, '');
}

/**
 * Collapses id-like path segments so `/pokemon/25` and `/pokemon/150` form one
 * endpoint. Without this, request grouping explodes in cardinality.
 */
export function normalizeEndpoint(url: string): string {
  const isAbsolute = /^https?:\/\//i.test(url);
  const parsed = new URL(url, 'http://relative.invalid');
  const path = parsed.pathname
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
  return isAbsolute ? `${parsed.origin}${path}` : path;
}
