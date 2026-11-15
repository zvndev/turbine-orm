import { bounded } from '../../../tooling/optional-pg-transports/lifecycle.mjs';

// Race owned work against the existing lifecycle signal; attach a rejection
// handler to abandoned promises so teardown never waits for an uncooperative arm.
export async function execute(scope, operation, label, timeoutMs = 30000) {
  scope.assertOpen();
  const signal = scope.signal;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const value = await bounded(Promise.race([Promise.resolve().then(operation), aborted]), timeoutMs, label);
    scope.assertOpen();
    return value;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
