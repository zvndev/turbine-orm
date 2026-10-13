/**
 * turbine-orm CLI: shared guards for the local servers
 *
 * A leaf module (Node's crypto and nothing else), the same role as
 * `cli/rate-limit.ts`: Studio and Observe both bind a loopback port behind a
 * random token, and the checks below are the parts of that perimeter that are
 * identical for both, so neither server grows its own copy.
 *
 *  - {@link isAllowedHostHeader}: a request whose `Host` names anything but this
 *    server is refused. This is what stops DNS rebinding: a page on an attacker's
 *    domain that re-resolves to 127.0.0.1 still sends `Host: attacker.example`.
 *  - {@link createLoginGate} / {@link redeemLogin}: the URL printed in the
 *    terminal carries a ONE-TIME login token, separate from the credential the
 *    session then uses, so a URL that lands in browser history, a process
 *    listing or a log is a spent ticket and not a standing key.
 *  - {@link constantTimeEqual}: the one token comparison.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Compare two secrets without leaking length or content through timing. Both
 * sides are hashed to fixed-length digests first, so `timingSafeEqual` never
 * throws on a length mismatch.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

// ---------------------------------------------------------------------------
// Host header allowlist
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];
const WILDCARD_HOSTNAMES = new Set(['0.0.0.0', '[::]', '::']);
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** `host`, `host:port`, `[v6]` or `[v6]:port`, or null when it is none of those. */
function parseHostHeader(value: string): { hostname: string; port: string | null } | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return null;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end < 0) return null;
    const rest = trimmed.slice(end + 1);
    if (rest === '') return { hostname: trimmed.slice(0, end + 1), port: null };
    if (!/^:\d+$/.test(rest)) return null;
    return { hostname: trimmed.slice(0, end + 1), port: rest.slice(1) };
  }
  const colon = trimmed.indexOf(':');
  if (colon < 0) return { hostname: trimmed, port: null };
  // A bare name never contains a second colon: that would be an unbracketed IPv6.
  if (trimmed.indexOf(':', colon + 1) >= 0) return null;
  const port = trimmed.slice(colon + 1);
  if (!/^\d+$/.test(port)) return null;
  return { hostname: trimmed.slice(0, colon), port };
}

function bracketIfIpv6(host: string): string {
  const lower = host.toLowerCase();
  return lower.includes(':') && !lower.startsWith('[') ? `[${lower}]` : lower;
}

/**
 * Is this `Host` header one this server should answer to?
 *
 * Allowed: the loopback names (`127.0.0.1`, `localhost`, `[::1]`) and the host
 * the server was bound to, each on the bound port. A server bound to a wildcard
 * address (`0.0.0.0`, `::`) also accepts an IP literal, because it has no single
 * name and a literal address cannot be rebound: rebinding needs a DNS name the
 * attacker controls.
 *
 * An ABSENT header is allowed. HTTP/1.1 requires it and Node answers 400 itself
 * when it is missing, so the only request that reaches this check without one is
 * an HTTP/1.0 client, which is not a browser and can say anything anyway. The
 * attack this refuses needs a browser, and a browser always sends one.
 */
export function isAllowedHostHeader(header: string | string[] | undefined, boundHost: string, port: number): boolean {
  if (header === undefined) return true;
  if (typeof header !== 'string') return false;
  const parsed = parseHostHeader(header);
  if (!parsed) return false;
  if (parsed.port === null ? port !== 80 : parsed.port !== String(port)) return false;

  const bound = bracketIfIpv6(boundHost);
  if (parsed.hostname === bound || LOOPBACK_HOSTNAMES.includes(parsed.hostname)) return true;
  if (WILDCARD_HOSTNAMES.has(boundHost.toLowerCase()) || WILDCARD_HOSTNAMES.has(bound)) {
    return IPV4_LITERAL.test(parsed.hostname) || parsed.hostname.startsWith('[');
  }
  return false;
}

// ---------------------------------------------------------------------------
// One-time login
// ---------------------------------------------------------------------------

/** The one-time ticket carried by the URL a server prints. */
export interface LoginGate {
  /** The value in the printed URL's `?token=`. Never a session credential. */
  readonly token: string;
  /** True once a GET carrying the token has been exchanged for a session cookie. */
  used: boolean;
}

export type LoginOutcome = 'granted' | 'used' | 'invalid';

/** Mint a gate. `token` is only passed by a caller that has no separate one to give. */
export function createLoginGate(token: string = randomBytes(24).toString('hex')): LoginGate {
  return { token, used: false };
}

/**
 * Try to exchange `candidate` for a session. `granted` happens at most once per
 * gate; afterwards the same token reports `used`, which a server must refuse.
 */
export function redeemLogin(gate: LoginGate, candidate: string): LoginOutcome {
  if (!constantTimeEqual(candidate, gate.token)) return 'invalid';
  if (gate.used) return 'used';
  gate.used = true;
  return 'granted';
}
