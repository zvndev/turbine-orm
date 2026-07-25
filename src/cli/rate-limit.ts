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
    // Start a new window
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
