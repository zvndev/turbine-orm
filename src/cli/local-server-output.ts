/**
 * What the two local servers (Studio and Observe) send OUT of the process: the
 * text of an error response, and the command that opens a browser. A leaf that
 * imports only `node:child_process`, so both servers share one copy.
 *
 * Both exist because the input to them is not entirely ours. A caught value can
 * be anything a dependency threw, and the host in the printed URL comes from a
 * command-line flag.
 */

import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Error text for an HTTP response
// ---------------------------------------------------------------------------

const UNEXPECTED_ERROR = 'unexpected error';

/**
 * The text a Studio or Observe error response may carry for a caught value.
 *
 * An `Error` contributes its own message, and only that: never `stack`, and
 * never the result of stringifying the object (a `toString` on a foreign error
 * type is free to print one). When the message is empty, which is what Node's
 * `AggregateError` has for a refused connection, the messages of the errors it
 * aggregates or its `cause` are used, then its `code`, then its name. A thrown
 * value that is not an `Error` has nothing safe to say, so it gets a fixed
 * sentence rather than a rendering of whatever it was.
 */
export function responseErrorText(err: unknown): string {
  return err instanceof Error ? errorMessage(err, 0) : UNEXPECTED_ERROR;
}

function errorMessage(err: Error, depth: number): string {
  if (err.message) return err.message;
  if (depth < 4) {
    const inner = (err as { errors?: unknown }).errors;
    if (Array.isArray(inner)) {
      const parts = new Set<string>();
      for (const e of inner) {
        const text = e instanceof Error ? errorMessage(e, depth + 1) : '';
        if (text !== '') parts.add(text);
      }
      if (parts.size > 0) return [...parts].join('; ');
    }
    if (err.cause instanceof Error) {
      const cause = errorMessage(err.cause, depth + 1);
      if (cause !== '') return cause;
    }
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code !== '') return code;
  return err.name || 'Error';
}

// ---------------------------------------------------------------------------
// Browser launch
// ---------------------------------------------------------------------------

/**
 * The only URL shape a server launches: plain `http`, a host name or IP
 * literal, a port, and optionally the one-time `?token=`. The host comes from
 * `--host`, and on Windows the URL is an argument of `cmd /c start`, where `&`,
 * `|`, `^`, `%` and `"` are command syntax rather than data, so anything outside
 * this set is not handed to a launcher at all. The URL is still printed.
 */
const LAUNCHABLE_URL = /^http:\/\/(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\]):\d{1,5}\/(?:\?token=[A-Za-z0-9_-]+)?$/;

/** @internal exported for tests. */
export function isLaunchableUrl(url: string): boolean {
  return LAUNCHABLE_URL.test(url);
}

/** @internal the seams the tests replace; production passes neither. */
export interface BrowserLaunch {
  platform: string;
  spawn: typeof spawn;
}

/**
 * Open `url` in the user's browser. Best effort: false when the URL is not one
 * of ours to launch or the launcher could not be started, and the caller has
 * already printed the URL either way.
 *
 * The launcher is started directly with an argument list and no shell
 * (`xdg-open <url>`, `open <url>`, and on Windows `cmd /c start "" <url>`).
 * A launcher that is not installed is reported as an 'error' EVENT rather than
 * a throw, and with no listener Node turns it into an uncaught exception that
 * ends the server right after it printed its address.
 */
export function openInBrowser(url: string, launch: BrowserLaunch = { platform: process.platform, spawn }): boolean {
  if (!isLaunchableUrl(url)) return false;
  const [command, args]: [string, string[]] =
    launch.platform === 'darwin'
      ? ['open', [url]]
      : launch.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = launch.spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
