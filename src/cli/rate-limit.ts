/**
 * turbine-orm CLI: fixed-window rate limiter
 *
 * A pure leaf module (same role as `cli/destructive.ts`): no imports beyond a
 * Node type, no I/O, no state of its own. Both local servers, Studio and
 * Observe, throttle through it so they behave identically without either one
 * importing the other. Studio in particular statically pulls in the embedded
 * UI, the demo store, PII redaction and QueryInterface, none of which Observe
 * has any use for.
 */

import type { IncomingMessage } from 'node:http';

export const RATE_LIMIT_WINDOW_MS = 60_000; // 60 seconds
export const RATE_LIMIT_MAX_REQUESTS = 100;

/**
 * Bucket identity for one caller. These are loopback tools with a single shared
 * token, so the remote address is the only thing that distinguishes one client
 * from another; requests with no socket (in-process dispatch) share one key.
 */
export function callerKey(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Sweep expired windows once the map reaches this many keys. Below it the map
 * is small enough that walking it on every new window would cost more than the
 * memory it reclaims.
 */
const RATE_LIMIT_SWEEP_AT = 1_000;

/**
 * Hard ceiling on tracked keys, enforced after the sweep. Only reachable when
 * that many DISTINCT callers appear inside a single window, which on a
 * loopback-bound server cannot happen at all.
 */
const RATE_LIMIT_MAX_KEYS = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  resetAt: number;
}

/**
 * Fixed-window counter. `limiter` is the caller's own state map (each server
 * owns one, so exhausting one server's budget never touches the other's) and
 * `token` is the bucket key, not a credential.
 */
export function checkRateLimit(
  limiter: Map<string, { count: number; resetAt: number }>,
  token: string,
): RateLimitResult {
  const now = Date.now();
  const entry = limiter.get(token);

  if (!entry || now >= entry.resetAt) {
    // Start a new window.
    //
    // SWEEP FIRST, because nothing else ever removes an entry. The key is the
    // caller's address, so on a loopback-only server the map holds exactly one
    // key forever and none of this matters; under `--allow-remote` it is one
    // permanent entry per source address that has ever connected, and an
    // attacker chooses how many of those there are. Both bounds are here on
    // purpose: the sweep is the correct fix (an expired window is dead state
    // with nothing to preserve) and the cap is the backstop for the case the
    // sweep cannot handle, a burst of distinct addresses INSIDE one window.
    //
    // The cap evicts in insertion order, i.e. oldest window first, which is the
    // safe direction: it can only ever forgive a caller early, never deny one
    // that is within its budget.
    if (limiter.size >= RATE_LIMIT_SWEEP_AT) {
      for (const [key, value] of limiter) {
        if (now >= value.resetAt) limiter.delete(key);
      }
      while (limiter.size >= RATE_LIMIT_MAX_KEYS) {
        const oldest = limiter.keys().next();
        if (oldest.done) break;
        limiter.delete(oldest.value);
      }
    }
    const resetAt = now + RATE_LIMIT_WINDOW_MS;
    limiter.set(token, { count: 1, resetAt });
    return { allowed: true, resetAt };
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, resetAt: entry.resetAt };
  }

  return { allowed: true, resetAt: entry.resetAt };
}
