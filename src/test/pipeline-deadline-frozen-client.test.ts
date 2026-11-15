/** A pipeline deadline must not break a supplied client whose own members are locked. Fails until fixed. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { PgCompatPool } from '../pg-types.js';
import { executePipeline } from '../pipeline.js';

it('a sequential deadline preserves a frozen object-literal client', async () => {
  for (const timeout of [undefined, 1000]) {
    const sent: string[] = [];
    const releases: unknown[] = [];
    let wrapped = 0;
    // An object-literal client freezes to read-only, non-configurable own
    // function members; its arrays stay mutable (the freeze is shallow).
    const client = Object.freeze({
      query: async (text: string) => {
        sent.push(text);
        return { rows: [], rowCount: 1, fields: [], command: text.split(' ')[0] };
      },
      wrapTransactionCallback: async <R>(body: () => Promise<R>): Promise<R> => {
        wrapped++;
        return body();
      },
      release: (error?: Error | boolean): void => {
        releases.push(error);
      },
    });
    const pool = { connect: async () => client } as unknown as PgCompatPool;
    const value = await executePipeline(
      pool,
      [{ sql: 'SELECT 1', params: [], tag: 'one', transform: (raw) => raw.rowCount }],
      { timeout },
    );
    assert.deepEqual(value, [1]);
    assert.equal(wrapped, 1);
    assert.deepEqual(sent, ['BEGIN', 'SELECT 1', 'COMMIT']);
    assert.deepEqual(releases, [undefined]);
  }
});
