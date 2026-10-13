/**
 * The text the CLI prints for a caught error. A zero-import leaf, so every
 * command can use it.
 *
 * Reading `.message` alone is not enough. When `localhost` resolves to both
 * `::1` and `127.0.0.1` and both refuse, Node's `net` rejects with an
 * `AggregateError` whose message is EMPTY: the reasons are on its `errors`.
 * Every command then printed its prefix and nothing else ("Failed to start
 * Studio: "), and the top-level handler, which classifies by message text,
 * could not tell that it was a refused connection.
 *
 * Order: the error's own message; else the messages of the errors it
 * aggregates (each once); else its `cause`; else its `code`; else its name.
 */
export function errorText(err: unknown, depth = 0): string {
  if (!(err instanceof Error)) return String(err);
  if (err.message) return err.message;
  if (depth < 4) {
    const inner = (err as { errors?: unknown }).errors;
    if (Array.isArray(inner)) {
      const parts = [...new Set(inner.map((e) => errorText(e, depth + 1)).filter((t) => t !== ''))];
      if (parts.length > 0) return parts.join('; ');
    }
    if (err.cause !== undefined) {
      const cause = errorText(err.cause, depth + 1);
      if (cause !== '') return cause;
    }
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code !== '') return code;
  return err.name || 'Error';
}
