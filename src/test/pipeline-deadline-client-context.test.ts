/** An unreached pipeline deadline must preserve the supplied client's method receiver. Fails until fixed. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { PgCompatPool, PgCompatPoolClient } from '../pg-types.js';
import { executePipeline } from '../pipeline.js';

it('a sequential deadline preserves a class-based transaction callback hook', async () => {
  class Client implements PgCompatPoolClient {
    #wrapped = 0;
    readonly sent: string[] = [];
    readonly releases: unknown[] = [];
    async query(text: string) {
      this.sent.push(text);
      return { rows: [], rowCount: 1, fields: [], command: text.split(' ')[0] };
    }
    async wrapTransactionCallback<R>(body: () => Promise<R>): Promise<R> {
      this.#wrapped++;
      return body();
    }
    release(error?: Error | boolean): void {
      this.releases.push(error);
    }
    get wrapped(): number {
      return this.#wrapped;
    }
  }

  for (const timeout of [undefined, 1000]) {
    const client = new Client();
    const pool = { connect: async () => client } as unknown as PgCompatPool;
    const value = await executePipeline(
      pool,
      [{ sql: 'SELECT 1', params: [], tag: 'one', transform: (raw) => raw.rowCount }],
      { timeout },
    );
    assert.deepEqual(value, [1]);
    assert.equal(client.wrapped, 1);
    assert.deepEqual(client.sent, ['BEGIN', 'SELECT 1', 'COMMIT']);
    assert.deepEqual(client.releases, [undefined]);
  }
});
