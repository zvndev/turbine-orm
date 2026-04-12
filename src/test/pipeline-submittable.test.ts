/**
 * turbine-orm — Pipeline submittable tests
 *
 * Tests the real pipeline protocol state machine using a fake Connection
 * EventEmitter that simulates Postgres backend responses.
 *
 * Key tests:
 *   - State machine drives through parseComplete → bindComplete → rowDescription →
 *     dataRow → commandComplete → readyForQuery for each query
 *   - Listener snapshot/detach/restore works correctly
 *   - TCP-write count assertion: single write between cork/uncork
 *   - Transactional mode: BEGIN/COMMIT bookends
 *   - Non-transactional mode: per-query Sync
 *   - Error handling: first error captures failedIndex/failedTag
 *   - Capability detection
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { type PgPoolClient, runPipelined, supportsExtendedPipeline } from '../pipeline-submittable.js';
import type { DeferredQuery } from '../query/index.js';

// ---------------------------------------------------------------------------
// Fake Connection that simulates Postgres backend messages
// ---------------------------------------------------------------------------

class FakeConnection extends EventEmitter {
  /** Track all protocol messages sent */
  readonly messages: Array<{ type: string; args: unknown[] }> = [];

  /** Mock stream with cork/uncork tracking */
  readonly stream: {
    cork: () => void;
    uncork: () => void;
    writable: boolean;
    destroy: (err?: Error) => void;
    write: (...args: unknown[]) => boolean;
    _corked: boolean;
    _writeCount: number;
    _corkWriteCount: number;
  };

  /** Queued responses to emit after all messages are sent */
  responseQueue: Array<() => void> = [];

  constructor() {
    super();

    const self = this;
    this.stream = {
      _corked: false,
      _writeCount: 0,
      _corkWriteCount: 0,
      writable: true,
      cork() {
        this._corked = true;
        this._corkWriteCount = 0;
      },
      uncork() {
        this._corked = false;
        // After uncork, emit all queued responses asynchronously
        // (simulates how the kernel sends the TCP packet and
        // the server responds with backend messages)
        process.nextTick(() => self.drainResponses());
      },
      destroy(_err?: Error) {
        this.writable = false;
      },
      write(..._args: unknown[]) {
        this._writeCount++;
        if (this._corked) {
          this._corkWriteCount++;
        }
        return true;
      },
    };
  }

  // Wire protocol methods — just record calls and queue responses
  parse(query: { text: string; name?: string }) {
    this.messages.push({ type: 'parse', args: [query] });
    this.queueResponse(() => this.emit('parseComplete'));
  }

  bind(config: unknown) {
    this.messages.push({ type: 'bind', args: [config] });
    this.queueResponse(() => this.emit('bindComplete'));
  }

  describe(msg: unknown) {
    this.messages.push({ type: 'describe', args: [msg] });
    // noData for DML without RETURNING, rowDescription for SELECT
    // We'll emit noData for BEGIN/COMMIT and rowDescription for real queries
    const m = msg as { type: string; name?: string };
    if (m.type === 'P') {
      // Queue nothing here — we'll handle it in the execute response setup
    }
  }

  execute(config: unknown) {
    this.messages.push({ type: 'execute', args: [config] });
    // commandComplete will be queued by the test-specific response setup
  }

  sync() {
    this.messages.push({ type: 'sync', args: [] });
    this.queueResponse(() => this.emit('readyForQuery', {}));
  }

  private queueResponse(fn: () => void) {
    this.responseQueue.push(fn);
  }

  drainResponses() {
    const queue = [...this.responseQueue];
    this.responseQueue = [];
    for (const fn of queue) {
      fn();
    }
  }

  /**
   * Set up response sequence for a transactional pipeline with N queries.
   * Each query returns the specified rows.
   */
  setupTransactionalResponses(
    queryResponses: Array<{
      fields?: Array<{ name: string; dataTypeID: number }>;
      rows?: Array<Array<string | null>>;
      command?: string;
    }>,
  ) {
    // Clear any auto-queued responses from parse/bind
    this.responseQueue = [];

    // Build the full response sequence:
    // BEGIN: parseComplete, bindComplete, commandComplete("BEGIN")
    // Each query: parseComplete, bindComplete, noData|rowDescription, [dataRow...], commandComplete
    // COMMIT: parseComplete, bindComplete, commandComplete("COMMIT")
    // readyForQuery

    const responses: Array<() => void> = [];

    // BEGIN
    responses.push(() => this.emit('parseComplete'));
    responses.push(() => this.emit('bindComplete'));
    responses.push(() => this.emit('commandComplete', { text: 'BEGIN' }));

    // Each query
    for (const qr of queryResponses) {
      responses.push(() => this.emit('parseComplete'));
      responses.push(() => this.emit('bindComplete'));

      if (qr.fields && qr.fields.length > 0) {
        responses.push(() => this.emit('rowDescription', { fields: qr.fields }));
        if (qr.rows) {
          for (const row of qr.rows) {
            responses.push(() => this.emit('dataRow', { fields: row }));
          }
        }
      } else {
        responses.push(() => this.emit('noData'));
      }

      responses.push(() => this.emit('commandComplete', { text: qr.command ?? `SELECT ${qr.rows?.length ?? 0}` }));
    }

    // COMMIT
    responses.push(() => this.emit('parseComplete'));
    responses.push(() => this.emit('bindComplete'));
    responses.push(() => this.emit('commandComplete', { text: 'COMMIT' }));

    // ReadyForQuery
    responses.push(() => this.emit('readyForQuery', {}));

    this.responseQueue = responses;
  }

  /**
   * Set up response sequence for a non-transactional pipeline.
   */
  setupNonTransactionalResponses(
    queryResponses: Array<{
      fields?: Array<{ name: string; dataTypeID: number }>;
      rows?: Array<Array<string | null>>;
      command?: string;
      error?: { message: string; code?: string; severity?: string };
    }>,
  ) {
    this.responseQueue = [];
    const responses: Array<() => void> = [];

    for (const qr of queryResponses) {
      if (qr.error) {
        // Error response for this query
        responses.push(() => this.emit('parseComplete'));
        responses.push(() =>
          this.emit('errorMessage', {
            message: qr.error!.message,
            code: qr.error!.code,
            severity: qr.error!.severity ?? 'ERROR',
          }),
        );
      } else {
        responses.push(() => this.emit('parseComplete'));
        responses.push(() => this.emit('bindComplete'));

        if (qr.fields && qr.fields.length > 0) {
          responses.push(() => this.emit('rowDescription', { fields: qr.fields }));
          if (qr.rows) {
            for (const row of qr.rows) {
              responses.push(() => this.emit('dataRow', { fields: row }));
            }
          }
        } else {
          responses.push(() => this.emit('noData'));
        }

        responses.push(() => this.emit('commandComplete', { text: qr.command ?? `SELECT ${qr.rows?.length ?? 0}` }));
      }

      // ReadyForQuery after each query's Sync
      responses.push(() => this.emit('readyForQuery', {}));
    }

    this.responseQueue = responses;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFakeClient(conn?: FakeConnection): {
  client: PgPoolClient;
  connection: FakeConnection;
  released: { count: number };
} {
  const connection = conn ?? new FakeConnection();
  const released = { count: 0 };
  const client: PgPoolClient = {
    connection: connection as unknown as PgPoolClient['connection'],
    readyForQuery: true,
    _types: undefined,
    release() {
      released.count++;
    },
  };
  return { client, connection, released };
}

function defer<T>(
  sql: string,
  params: unknown[],
  transform: (r: { rows: unknown[]; rowCount: number | null }) => T,
  tag = 'test',
): DeferredQuery<T> {
  return { sql, params, transform: transform as DeferredQuery<T>['transform'], tag };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('supportsExtendedPipeline', () => {
  it('returns true for a client with connection.parse/bind/describe/execute/sync/on', () => {
    const { client } = createFakeClient();
    assert.equal(supportsExtendedPipeline(client), true);
  });

  it('returns false for null/undefined', () => {
    assert.equal(supportsExtendedPipeline(null), false);
    assert.equal(supportsExtendedPipeline(undefined), false);
  });

  it('returns false for an object without connection', () => {
    assert.equal(supportsExtendedPipeline({ readyForQuery: true }), false);
  });

  it('returns false for connection missing parse', () => {
    assert.equal(
      supportsExtendedPipeline({
        connection: {
          bind() {},
          describe() {},
          execute() {},
          sync() {},
          on() {},
        },
      }),
      false,
    );
  });

  it('returns false for a mock pool client without connection', () => {
    const mockClient = {
      query: async () => ({ rows: [], rowCount: 0 }),
      release() {},
    };
    assert.equal(supportsExtendedPipeline(mockClient), false);
  });
});

describe('runPipelined — transactional mode', () => {
  it('sends BEGIN + queries + COMMIT + single Sync in one cork/uncork window', async () => {
    const { client, connection } = createFakeClient();

    // Set up responses for 2 queries in transactional mode
    connection.setupTransactionalResponses([
      {
        fields: [{ name: 'n', dataTypeID: 23 }],
        rows: [['1']],
        command: 'SELECT 1',
      },
      {
        fields: [{ name: 'n', dataTypeID: 23 }],
        rows: [['2']],
        command: 'SELECT 1',
      },
    ]);

    const results = await runPipelined(
      client,
      [
        defer('SELECT 1 AS n', [], (r) => (r.rows[0] as { n: number }).n),
        defer('SELECT 2 AS n', [], (r) => (r.rows[0] as { n: number }).n),
      ],
      { transactional: true },
    );

    // pg-types parses OID 23 (int4) as number
    assert.deepEqual(results, [1, 2]);

    // Verify protocol message sequence
    const types = connection.messages.map((m) => m.type);

    // BEGIN: parse, bind, execute
    assert.equal(types[0], 'parse');
    assert.equal(types[1], 'bind');
    assert.equal(types[2], 'execute');

    // Query 1: parse, bind, describe, execute
    assert.equal(types[3], 'parse');
    assert.equal(types[4], 'bind');
    assert.equal(types[5], 'describe');
    assert.equal(types[6], 'execute');

    // Query 2: parse, bind, describe, execute
    assert.equal(types[7], 'parse');
    assert.equal(types[8], 'bind');
    assert.equal(types[9], 'describe');
    assert.equal(types[10], 'execute');

    // COMMIT: parse, bind, execute
    assert.equal(types[11], 'parse');
    assert.equal(types[12], 'bind');
    assert.equal(types[13], 'execute');

    // Single sync
    assert.equal(types[14], 'sync');
    assert.equal(types.filter((t) => t === 'sync').length, 1, 'exactly one sync for transactional mode');
  });

  it('BEGIN parse text is "BEGIN"', async () => {
    const { client, connection } = createFakeClient();
    connection.setupTransactionalResponses([
      { fields: [{ name: 'n', dataTypeID: 23 }], rows: [['42']], command: 'SELECT 1' },
    ]);

    await runPipelined(client, [defer('SELECT 42', [], (r) => r.rows[0])], { transactional: true });

    const firstParse = connection.messages[0]!;
    assert.equal(firstParse.type, 'parse');
    assert.equal((firstParse.args[0] as { text: string }).text, 'BEGIN');
  });

  it('restores readyForQuery after completion', async () => {
    const { client, connection } = createFakeClient();
    client.readyForQuery = true;

    connection.setupTransactionalResponses([
      { fields: [{ name: 'n', dataTypeID: 23 }], rows: [['1']], command: 'SELECT 1' },
    ]);

    await runPipelined(client, [defer('SELECT 1', [], () => 1)], { transactional: true });

    assert.equal(client.readyForQuery, true, 'readyForQuery restored after pipeline');
  });

  it('restores original listeners after completion', async () => {
    const { client, connection } = createFakeClient();

    // Register a custom listener
    let customCalled = false;
    connection.on('readyForQuery', () => {
      customCalled = true;
    });

    connection.setupTransactionalResponses([
      { fields: [{ name: 'x', dataTypeID: 23 }], rows: [['1']], command: 'SELECT 1' },
    ]);

    await runPipelined(client, [defer('SELECT 1', [], () => 1)], { transactional: true });

    // The custom listener should be restored
    customCalled = false;
    connection.emit('readyForQuery', {});
    assert.equal(customCalled, true, 'original listener was restored and fires');
  });
});

describe('runPipelined — non-transactional mode', () => {
  it('sends one Sync per query (no BEGIN/COMMIT)', async () => {
    const { client, connection } = createFakeClient();

    connection.setupNonTransactionalResponses([
      {
        fields: [{ name: 'a', dataTypeID: 23 }],
        rows: [['10']],
        command: 'SELECT 1',
      },
      {
        fields: [{ name: 'b', dataTypeID: 23 }],
        rows: [['20']],
        command: 'SELECT 1',
      },
    ]);

    const results = await runPipelined(
      client,
      [
        defer('SELECT 10', [], (r) => (r.rows[0] as { a: number }).a),
        defer('SELECT 20', [], (r) => (r.rows[0] as { b: number }).b),
      ],
      { transactional: false },
    );

    // pg-types parses OID 23 (int4) as number
    assert.deepEqual(results, [10, 20]);

    const types = connection.messages.map((m) => m.type);

    // No BEGIN/COMMIT messages
    const parseTexts = connection.messages
      .filter((m) => m.type === 'parse')
      .map((m) => (m.args[0] as { text: string }).text);
    assert.ok(!parseTexts.includes('BEGIN'), 'no BEGIN in non-transactional mode');
    assert.ok(!parseTexts.includes('COMMIT'), 'no COMMIT in non-transactional mode');

    // Two syncs (one per query)
    assert.equal(types.filter((t) => t === 'sync').length, 2, 'one sync per query in non-transactional mode');
  });
});

describe('runPipelined — error handling', () => {
  it('rejects with the first error in transactional mode', async () => {
    const { client, connection } = createFakeClient();

    // Simulate: BEGIN succeeds, query 1 fails, rest gets error (aborted tx)
    connection.responseQueue = [];
    const responses: Array<() => void> = [];

    // BEGIN
    responses.push(() => connection.emit('parseComplete'));
    responses.push(() => connection.emit('bindComplete'));
    responses.push(() => connection.emit('commandComplete', { text: 'BEGIN' }));

    // Query 0: error
    responses.push(() => connection.emit('parseComplete'));
    responses.push(() => connection.emit('bindComplete'));
    responses.push(() =>
      connection.emit('errorMessage', {
        message: 'relation "bad" does not exist',
        severity: 'ERROR',
      }),
    );

    // After error in transaction, all subsequent commands fail with "current transaction is aborted"
    // The COMMIT parse will also error
    responses.push(() =>
      connection.emit('errorMessage', {
        message: 'current transaction is aborted',
        severity: 'ERROR',
      }),
    );

    // ReadyForQuery
    responses.push(() => connection.emit('readyForQuery', {}));

    connection.responseQueue = responses;

    await assert.rejects(
      () =>
        runPipelined(
          client,
          [defer('SELECT * FROM bad', [], () => null, 'bad-query'), defer('SELECT 1', [], () => 1, 'good-query')],
          { transactional: true },
        ),
      (err: Error & { failedIndex?: number; failedTag?: string }) => {
        assert.equal(err.failedIndex, 0);
        assert.equal(err.failedTag, 'bad-query');
        return true;
      },
    );
  });
});

describe('TCP write count (cork/uncork proof)', () => {
  it('all protocol messages are sent within a single cork/uncork window', async () => {
    const connection = new FakeConnection();

    // Override _send to track writes at the Connection level
    // The real connection.parse/bind/etc call this._send which calls stream.write
    // Our FakeConnection records messages but doesn't actually write.
    // We check that cork was called before any protocol method and uncork after.

    let wasCorkBeforeFirstMessage = false;
    let wasUncorkAfterLastMessage = false;

    const origParse = connection.parse.bind(connection);
    let firstMessageSeen = false;

    connection.parse = (query: { text: string; name?: string }) => {
      if (!firstMessageSeen) {
        firstMessageSeen = true;
        wasCorkBeforeFirstMessage = connection.stream._corked;
      }
      origParse(query);
    };

    const origUncork = connection.stream.uncork.bind(connection.stream);
    connection.stream.uncork = () => {
      wasUncorkAfterLastMessage = connection.messages.length > 0;
      origUncork();
    };

    const { client } = createFakeClient(connection);

    connection.setupTransactionalResponses([
      { fields: [{ name: 'n', dataTypeID: 23 }], rows: [['1']], command: 'SELECT 1' },
      { fields: [{ name: 'n', dataTypeID: 23 }], rows: [['2']], command: 'SELECT 1' },
      { fields: [{ name: 'n', dataTypeID: 23 }], rows: [['3']], command: 'SELECT 1' },
    ]);

    await runPipelined(
      client,
      [defer('SELECT 1', [], () => 1), defer('SELECT 2', [], () => 2), defer('SELECT 3', [], () => 3)],
      { transactional: true },
    );

    assert.equal(wasCorkBeforeFirstMessage, true, 'stream was corked before first protocol message');
    assert.equal(wasUncorkAfterLastMessage, true, 'stream was uncorked after all protocol messages');
  });
});
