const SESSION_KEY = 'fop:session';

export function createId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  // randomUUID only exists in secure contexts (HTTPS/localhost); getRandomValues
  // works everywhere, so build a v4 UUID by hand.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * One session per tab: it survives reloads but not new tabs. Storage can throw
 * (privacy modes, sandboxed iframes), in which case the session lasts as long
 * as the page.
 */
export function resolveSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const id = createId();
    sessionStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    return createId();
  }
}

/** Path only: query strings and hashes routinely carry tokens and emails. */
export function currentPage(): string {
  return typeof location === 'undefined' ? '/' : location.pathname;
}
