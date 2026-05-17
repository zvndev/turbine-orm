import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withRetry } from '../client.js';

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const result = await withRetry(() => Promise.resolve(42));
    assert.strictEqual(result, 42);
  });

  it('throws non-retryable errors immediately', async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        withRetry(() => {
          attempts++;
          throw new Error('not retryable');
        }),
      { message: 'not retryable' },
    );
    assert.strictEqual(attempts, 1);
  });

  it('retries errors with isRetryable=true', async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('deadlock') as Error & { isRetryable: true };
          err.isRetryable = true;
          throw err;
        }
        return Promise.resolve('success');
      },
      { baseDelay: 1 },
    );
    assert.strictEqual(result, 'success');
    assert.strictEqual(attempts, 3);
  });

  it('throws after maxAttempts exhausted', async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        withRetry(
          () => {
            attempts++;
            const err = new Error('deadlock') as Error & { isRetryable: true };
            err.isRetryable = true;
            throw err;
          },
          { maxAttempts: 2, baseDelay: 1 },
        ),
      { message: 'deadlock' },
    );
    assert.strictEqual(attempts, 2);
  });

  it('calls onRetry callback', async () => {
    const retries: number[] = [];
    let attempts = 0;
    await withRetry(
      () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('serialization') as Error & { isRetryable: true };
          err.isRetryable = true;
          throw err;
        }
        return Promise.resolve('ok');
      },
      { baseDelay: 1, onRetry: (_err, attempt) => retries.push(attempt) },
    );
    assert.deepStrictEqual(retries, [1, 2]);
  });

  it('respects maxDelay cap', async () => {
    const start = Date.now();
    let attempts = 0;
    await withRetry(
      () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('retry') as Error & { isRetryable: true };
          err.isRetryable = true;
          throw err;
        }
        return Promise.resolve('done');
      },
      { baseDelay: 1, maxDelay: 5 },
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 100, `Expected fast execution, took ${elapsed}ms`);
  });
});
