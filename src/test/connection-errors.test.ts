/**
 * turbine-orm, connection-failure typing tests
 *
 * The README leads with "every error is typed". These tests pin the places
 * where that contract used to break at the connection boundary:
 *
 *   1. wrapPgError over synthesized driver errors: auth refusal (28P01/28000),
 *      missing database (3D000), socket codes, TLS codes, and the codes that
 *      must still pass through untouched.
 *   2. A real connection attempt against a socket that refuses, and against a
 *      fake server that answers the startup message with an authentication
 *      failure. No database required, both prove `pool.connect()` failures
 *      reach the caller as a typed ConnectionError.
 *   3. A malformed connection string is refused at construction, naming the
 *      string, instead of surfacing later as a DNS error about a fragment of
 *      itself.
 *
 * Run: npx tsx --test src/test/connection-errors.test.ts
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ConnectionError, TurbineErrorCode, wrapPgError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: {
    users: mockTable('users', [
      { name: 'id', field: 'id' },
      { name: 'email', field: 'email', pgType: 'text' },
    ]),
  },
  enums: {},
};

/** A pg-shaped driver error: a plain object carrying a `.code`, like pg throws. */
function driverError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

// ---------------------------------------------------------------------------
// 1. wrapPgError classification
// ---------------------------------------------------------------------------

describe('wrapPgError, connection-class SQLSTATEs', () => {
  it('maps 28P01 (wrong password) to ConnectionError instead of leaving it raw', () => {
    const raw = driverError('28P01', 'password authentication failed for user "postgres"');
    const wrapped = wrapPgError(raw);
    assert.ok(wrapped instanceof ConnectionError);
    assert.equal((wrapped as ConnectionError).code, TurbineErrorCode.CONNECTION);
  });

  it('exposes the driver SQLSTATE on ConnectionError.sqlstate so callers need no message matching', () => {
    const wrapped = wrapPgError(driverError('28P01', 'password authentication failed for user "postgres"'));
    assert.equal((wrapped as ConnectionError).sqlstate, '28P01');
  });

  it('keeps the driver message and appends a remediation hint for 28P01', () => {
    const wrapped = wrapPgError(driverError('28P01', 'password authentication failed for user "postgres"'));
    const msg = (wrapped as ConnectionError).message;
    assert.ok(msg.includes('password authentication failed for user "postgres"'), msg);
    assert.ok(msg.includes('28P01'), msg);
    assert.ok(msg.includes('Check the password'), msg);
  });

  it('preserves the original driver error as .cause', () => {
    const raw = driverError('28P01', 'password authentication failed for user "postgres"');
    const wrapped = wrapPgError(raw) as ConnectionError;
    assert.equal(wrapped.cause, raw);
  });

  it('maps 28000 (invalid authorization) to ConnectionError with a pg_hba hint', () => {
    const wrapped = wrapPgError(driverError('28000', 'no pg_hba.conf entry for host "10.0.0.1"'));
    assert.ok(wrapped instanceof ConnectionError);
    assert.ok((wrapped as ConnectionError).message.includes('pg_hba.conf'));
  });

  it('maps 3D000 (no such database) to ConnectionError naming the database segment', () => {
    const wrapped = wrapPgError(driverError('3D000', 'database "app_dev" does not exist'));
    assert.ok(wrapped instanceof ConnectionError);
    assert.equal((wrapped as ConnectionError).sqlstate, '3D000');
    assert.ok((wrapped as ConnectionError).message.includes('does not exist'));
  });

  it('maps socket-level codes (ECONNREFUSED, EAI_AGAIN, EHOSTUNREACH) to ConnectionError', () => {
    for (const code of ['ECONNREFUSED', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']) {
      const wrapped = wrapPgError(driverError(code, `connect ${code} 127.0.0.1:5432`));
      assert.ok(wrapped instanceof ConnectionError, `${code} was not wrapped`);
      assert.equal((wrapped as ConnectionError).sqlstate, code);
    }
  });

  it('maps TLS handshake codes to ConnectionError with a CA hint', () => {
    for (const code of ['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED']) {
      const wrapped = wrapPgError(driverError(code, 'self-signed certificate in certificate chain'));
      assert.ok(wrapped instanceof ConnectionError, `${code} was not wrapped`);
      assert.ok((wrapped as ConnectionError).message.includes('ssl:'), `${code} carried no CA hint`);
    }
  });

  it('leaves a non-connection SQLSTATE (42P01, undefined_table) unchanged', () => {
    const raw = driverError('42P01', 'relation "nope" does not exist');
    assert.equal(wrapPgError(raw), raw);
  });

  it('does not resolve a hint through Object.prototype for a driver-supplied code', () => {
    // `e.code` is driver text. A prototype-chain lookup on the hint map would
    // resolve "toString" to a function and interpolate it into the message.
    const raw = driverError('toString', 'nonsense');
    assert.equal(wrapPgError(raw), raw);
  });
});

// ---------------------------------------------------------------------------
// 2. Real connection attempts (no database required)
// ---------------------------------------------------------------------------

describe('TurbineClient.connect(), driver failures are typed', () => {
  it('surfaces a refused socket as ConnectionError, not a raw driver error', async () => {
    // Port 1 on loopback: nothing listens there, so the OS refuses immediately.
    const db = new TurbineClient(
      { host: '127.0.0.1', port: 1, database: 'nope', user: 'nope', connectionTimeoutMs: 2000 },
      schema,
    );
    try {
      await assert.rejects(
        () => db.connect(),
        (err: unknown) => {
          assert.ok(err instanceof ConnectionError, `expected ConnectionError, got ${String(err)}`);
          assert.equal(err.code, TurbineErrorCode.CONNECTION);
          assert.equal(err.sqlstate, 'ECONNREFUSED');
          return true;
        },
      );
    } finally {
      await db.disconnect();
    }
  });

  it('surfaces an authentication refusal (28P01) as ConnectionError with the driver message', async () => {
    // A server that speaks just enough of the protocol to refuse: read the
    // startup message, answer with an ErrorResponse carrying SQLSTATE 28P01.
    // This reproduces the wrong-password first run without a live Postgres.
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(errorResponse('28P01', 'password authentication failed for user "postgres"'));
        socket.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const db = new TurbineClient(
      { host: '127.0.0.1', port, database: 'app', user: 'postgres', password: 'wrong', connectionTimeoutMs: 2000 },
      schema,
    );
    try {
      await assert.rejects(
        () => db.connect(),
        (err: unknown) => {
          assert.ok(err instanceof ConnectionError, `expected ConnectionError, got ${String(err)}`);
          assert.equal(err.sqlstate, '28P01');
          assert.ok(err.message.includes('password authentication failed'), err.message);
          assert.ok(err.message.includes('Check the password'), err.message);
          return true;
        },
      );
    } finally {
      await db.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * Build a Postgres wire ErrorResponse message ('E'): int32 length, then
 * NUL-terminated fields (S severity, V severity, C SQLSTATE, M message),
 * terminated by a zero byte.
 */
function errorResponse(sqlstate: string, message: string): Buffer {
  const fields = Buffer.from(`SFATAL\0VFATAL\0C${sqlstate}\0M${message}\0\0`, 'utf8');
  const body = Buffer.alloc(4 + fields.length);
  body.writeInt32BE(4 + fields.length, 0);
  fields.copy(body, 4);
  return Buffer.concat([Buffer.from('E', 'utf8'), body]);
}

// ---------------------------------------------------------------------------
// 3. Malformed connection strings
// ---------------------------------------------------------------------------

describe('connection-string validation', () => {
  it('refuses a string with no scheme at all at construction', () => {
    assert.throws(
      () => new TurbineClient({ connectionString: 'postgres//app_dev' }, schema),
      (err: unknown) => {
        assert.ok(err instanceof ConnectionError);
        assert.equal(err.code, TurbineErrorCode.CONNECTION);
        assert.ok(err.message.includes('names no host'), err.message);
        assert.ok(err.message.includes('connectionString'), err.message);
        return true;
      },
    );
  });

  it('never echoes the connection string itself (it may carry a password)', () => {
    assert.throws(
      () => new TurbineClient({ connectionString: 'psql//user:hunter2@db.example.com/app' }, schema),
      (err: unknown) => {
        assert.ok(err instanceof ConnectionError);
        assert.ok(!err.message.includes('hunter2'), err.message);
        assert.ok(!err.message.includes('db.example.com'), err.message);
        return true;
      },
    );
  });

  it('refuses a whitespace-only connection string with a "expected postgresql://..." message', () => {
    assert.throws(
      () => new TurbineClient({ connectionString: '   ' }, schema),
      (err: unknown) => {
        assert.ok(err instanceof ConnectionError);
        assert.ok(err.message.includes('empty'), err.message);
        return true;
      },
    );
  });

  /**
   * The EMPTY string is not the whitespace-only string. pg ignores a falsy
   * `connectionString` and falls back to its own defaults, and so does the
   * pool-building branch in client.ts, so `process.env.DATABASE_URL ?? ''`
   * has always constructed. A validator that throws on it breaks that idiom.
   */
  it('accepts an empty connection string, exactly as before the validator existed', async () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const db = new TurbineClient({ connectionString: '' }, schema);
      await db.disconnect();
    } finally {
      if (previous !== undefined) process.env.DATABASE_URL = previous;
    }
  });

  it('accepts an empty string in replicas for the same reason', async () => {
    const db = new TurbineClient({ connectionString: 'postgres://localhost/app', replicas: [''] }, schema);
    await db.disconnect();
  });

  /**
   * Unix-domain-socket connection strings are a documented pg form and a
   * scheme-matching validator refused all of them, breaking peer-auth and
   * Google Cloud SQL deployments at `new TurbineClient(...)`. pg parses each of
   * these into a real host (see the oracle test below).
   */
  it('accepts unix-socket connection strings (peer auth, Cloud SQL)', async () => {
    for (const value of [
      '/var/run/postgresql app',
      '/var/run/postgresql',
      '/cloudsql/my-project:us-central1:my-instance',
      'socket:/var/run/postgresql?db=app',
      'postgres://user@/app?host=/var/run/postgresql',
      'postgres://%2Fvar%2Frun%2Fpostgresql/app',
    ]) {
      const db = new TurbineClient({ connectionString: value }, schema);
      // pg.Pool opens no socket until first use, so nothing to tear down but
      // the pool object itself.
      await db.disconnect();
    }
  });

  it('accepts the empty-host and no-authority URL forms pg resolves to localhost', async () => {
    for (const value of [
      'postgres://user:pw@localhost:5432/app',
      'postgresql://localhost/app',
      'postgresql:///app',
      'postgres:/app_dev',
      'postgres://',
      'postgres://user:pw@/app',
      'postgresql://u:p@[::1]:5432/db',
    ]) {
      const db = new TurbineClient({ connectionString: value }, schema);
      await db.disconnect();
    }
  });

  it('refuses a libpq keyword/value string, and says why (node-postgres does not implement it)', () => {
    assert.throws(
      () => new TurbineClient({ connectionString: 'host=localhost port=5432 dbname=app user=postgres' }, schema),
      (err: unknown) => {
        assert.ok(err instanceof ConnectionError);
        assert.ok(err.message.includes('libpq'), err.message);
        return true;
      },
    );
  });

  /**
   * THE oracle test. The validator's only legitimate boundary is what pg would
   * do with the string, so compare it against pg itself: constructing a
   * `pg.Client` parses the connection string (and opens nothing), so its
   * resolved `host` says whether pg could have connected. `base` is
   * pg-connection-string's internal placeholder host, i.e. pg silently lost the
   * string, and a constructor throw from pg means pg refuses it outright.
   *
   * Accept-when-pg-accepts matters as much as reject-when-pg-rejects: refusing
   * a string pg would have connected with breaks a working deployment.
   */
  it('agrees with pg itself on every string, in both directions', () => {
    const corpus = [
      '/var/run/postgresql app',
      '/cloudsql/proj:region:instance',
      'socket:/var/run/postgresql?db=app',
      'postgres://u:p@h:5432/db',
      'postgres://h/db?sslmode=disable',
      'postgresql:///db',
      'postgres:/app_dev',
      'postgres://',
      'postgres://user:pw@/db',
      'postgres://user@/app?host=/var/run/postgresql',
      'postgres://%2Fvar%2Frun%2Fpostgresql/app',
      'postgresql://u:p@[::1]:5432/db',
      'localhost:5432',
      'host=localhost dbname=app',
      'base',
      'not a url at all',
      'postgresql//user@host/db',
      '"postgres://u@h/db"',
      'my.db.example.com',
      'postgres://u:p@h:notanumber/db',
      '   ',
    ];
    for (const value of corpus) {
      // What pg would connect to, or nothing if pg refuses the string outright.
      let pgHost: string | undefined;
      let pgThrew = false;
      try {
        // `connectionParameters` is real but not in pg's published types.
        pgHost = (new pg.Client({ connectionString: value }) as unknown as { connectionParameters: { host?: string } })
          .connectionParameters.host;
      } catch {
        pgThrew = true;
      }
      const pgWouldConnect = !pgThrew && pgHost !== 'base';

      let turbineThrew = false;
      try {
        const db = new TurbineClient({ connectionString: value }, schema);
        void db.disconnect();
      } catch {
        turbineThrew = true;
      }
      assert.equal(
        turbineThrew,
        !pgWouldConnect,
        `disagreement on ${JSON.stringify(value)}: pg host ${pgThrew ? '<throws>' : JSON.stringify(pgHost)}, ` +
          `turbine ${turbineThrew ? 'threw' : 'accepted'}`,
      );
    }
  });

  it('validates the DATABASE_URL fallback, and names it as the source', () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres/app';
    try {
      assert.throws(
        () => new TurbineClient({}, schema),
        (err: unknown) => {
          assert.ok(err instanceof ConnectionError);
          assert.ok(err.message.includes('DATABASE_URL'), err.message);
          return true;
        },
      );
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it('ignores a bad DATABASE_URL when an explicit host is configured (pg would too)', async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'garbage';
    try {
      const db = new TurbineClient({ host: '127.0.0.1', port: 5432, database: 'app' }, schema);
      await db.disconnect();
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it('validates string replicas, naming the offending index', () => {
    assert.throws(
      () =>
        new TurbineClient(
          { connectionString: 'postgres://localhost/app', replicas: ['postgres://localhost/app', 'nonsense'] },
          schema,
        ),
      (err: unknown) => {
        assert.ok(err instanceof ConnectionError);
        assert.ok(err.message.includes('replicas[1]'), err.message);
        return true;
      },
    );
  });
});
