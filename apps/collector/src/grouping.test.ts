import { describe, expect, it } from 'vitest';
import { errorFingerprint, normalizeEndpoint, topFrame } from './grouping.ts';

const chromeStack = (file: string, message = 'boom') =>
  `TypeError: ${message}\n    at loadPokemon (${file}:12:34)\n    at onClick (https://app.test/assets/react.js:1:2)`;

describe('errorFingerprint', () => {
  it('groups occurrences whose messages differ only by variable data', () => {
    const a = errorFingerprint({
      name: 'Error',
      message: 'Pokemon 25 not found (id 3f2a9c1e-0b7d-4e5f-9a8b-1c2d3e4f5a6b)',
    });
    const b = errorFingerprint({
      name: 'Error',
      message: 'Pokemon 150 not found (id 9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b)',
    });
    expect(a).toBe(b);
  });

  it('keeps the same group across deploys that change bundle hashes and line numbers', () => {
    const before = errorFingerprint({
      name: 'TypeError',
      message: 'boom',
      stack: chromeStack('https://app.test/assets/index-DkA3bC9x.js'),
    });
    const after = errorFingerprint({
      name: 'TypeError',
      message: 'boom',
      stack: chromeStack('https://app.test/assets/index-Zz91Qw0p.js').replace(':12:34', ':80:1'),
    });
    expect(before).toBe(after);
  });

  it('separates errors with the same message thrown from different places', () => {
    const a = errorFingerprint({
      name: 'TypeError',
      message: 'boom',
      stack: chromeStack('https://app.test/a.js'),
    });
    const b = errorFingerprint({
      name: 'TypeError',
      message: 'boom',
      stack: chromeStack('https://app.test/b.js'),
    });
    expect(a).not.toBe(b);
  });

  it('separates different error names', () => {
    expect(errorFingerprint({ name: 'TypeError', message: 'x' })).not.toBe(
      errorFingerprint({ name: 'RangeError', message: 'x' }),
    );
  });
});

describe('topFrame', () => {
  it.each([
    [
      'Chrome',
      chromeStack('https://app.test/assets/index-DkA3bC9x.js?v=2'),
      'at loadPokemon (https://app.test/assets/index.js)',
    ],
    [
      'Firefox',
      'loadPokemon@https://app.test/assets/main.js:12:34\n@https://app.test/x.js:1:1',
      'loadPokemon@https://app.test/assets/main.js',
    ],
  ])('extracts the first %s frame without position, query or hash', (_browser, stack, expected) => {
    expect(topFrame(stack)).toBe(expected);
  });

  it('returns undefined without a recognizable frame', () => {
    expect(topFrame(undefined)).toBeUndefined();
    expect(topFrame('Error: no frames here')).toBeUndefined();
  });
});

describe('normalizeEndpoint', () => {
  it.each([
    ['https://api.test/pokemon/25', 'https://api.test/pokemon/:id'],
    [
      'https://api.test/users/3f2a9c1e-0b7d-4e5f-9a8b-1c2d3e4f5a6b/orders',
      'https://api.test/users/:id/orders',
    ],
    ['https://api.test/commits/a1b2c3d4e5f6a7b8c9d0', 'https://api.test/commits/:id'],
    ['https://api.test/pokemon/pikachu', 'https://api.test/pokemon/pikachu'],
    ['/api/pokemon/7', '/api/pokemon/:id'],
  ])('%s → %s', (url, expected) => {
    expect(normalizeEndpoint(url)).toBe(expected);
  });

  it('is stable across repeated calls', () => {
    const url = 'https://api.test/users/3f2a9c1e-0b7d-4e5f-9a8b-1c2d3e4f5a6b';
    expect(normalizeEndpoint(url)).toBe(normalizeEndpoint(url));
  });
});
