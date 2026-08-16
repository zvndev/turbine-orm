/**
 * turbine-orm - connection-pooler guard and connection-time statement_timeout.
 *
 * No database. Three things are under test, and they are the three halves of
 * one incident class:
 *
 *   1. `detectPooler` decides from a STRING whether an endpoint multiplexes
 *      backends. Its false positives are the expensive ones (they block a
 *      legitimate database), so the negative cases below are the point of the
 *      suite, not filler: a database named `poolers`, a role named
 *      `pooler_admin` and a host called `spooler.internal` all contain the
 *      letters and none of them is a pooler.
 *   2. `turbine doctor` refuses a pooled endpoint, BEFORE anything connects.
 *   3. The statistics collectors emit no session-level `SET`. That is asserted
 *      behaviourally by substituting pg's `Pool` and reading back every
 *      statement the collector actually issues, and again statically over the
 *      source, because the behavioural test only sees the paths it drives while
 *      the static one sees every line.
 *
 * Run: npx tsx --test src/test/pooler-guard.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type CliArgs, refusePoolerConnection } from '../cli/index.js';
import {
  detectPooler,
  POOLER_PORTS,
  parseConnectionTarget,
  poolerRefusalMessage,
  withStatementTimeoutOption,
} from '../connection-url.js';
import { collectStatsSnapshot, collectTableHeat } from '../index-stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 1. Detection
// ---------------------------------------------------------------------------

describe('detectPooler - endpoints that ARE poolers', () => {
  it('a Neon "-pooler" host', () => {
    const d = detectPooler(
      'postgresql://u:p@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/db?sslmode=require',
    );
    assert.equal(d.pooled, true);
    assert.equal(d.signal, 'host');
    assert.equal(d.matchedToken, 'pooler');
  });

  it('a Supabase pooler host, where "pooler" is a whole label', () => {
    const d = detectPooler('postgres://postgres.abcdef:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres');
    assert.equal(d.pooled, true);
    assert.equal(d.signal, 'host');
  });

  it('a pgbouncer host', () => {
    for (const url of [
      'postgres://u:p@pgbouncer.internal:5432/app',
      'postgres://u:p@pgbouncer-prod.svc.cluster.local:5432/app',
      'postgres://u:p@db-pgbouncer2.example.com:5432/app',
    ]) {
      const d = detectPooler(url);
      assert.equal(d.pooled, true, url);
      assert.equal(d.signal, 'host', url);
    }
  });

  it('a pooling port on an otherwise ordinary host', () => {
    // 6543 is the hosted transaction-pooling port; 6432 is PgBouncer's own
    // documented default `listen_port`.
    for (const port of [6543, 6432]) {
      const d = detectPooler(`postgres://u:p@10.0.0.4:${port}/app`);
      assert.equal(d.pooled, true, `port ${port}`);
      assert.equal(d.signal, 'port', `port ${port}`);
      assert.equal(d.port, port);
      assert.match(
        poolerRefusalMessage(d, { command: 'turbine doctor', allowFlag: '--allow-pooler' }).join('\n'),
        new RegExp(`port ${port} is a transaction-pooling port`),
      );
    }
    // This is the whole published port list; a change to it should be
    // deliberate, not a side effect of touching the detector.
    assert.deepEqual([...POOLER_PORTS], [6543, 6432]);
  });

  it('the key/value DSN form, not only URLs', () => {
    assert.equal(detectPooler('host=pgbouncer.internal port=5432 dbname=app').pooled, true);
    assert.equal(detectPooler('host=db.example.com port=6543 dbname=app').pooled, true);
  });
});

describe('detectPooler - endpoints that are NOT poolers', () => {
  it('an ordinary host', () => {
    for (const url of [
      'postgres://u:p@db.example.com:5432/app',
      'postgres://u:p@localhost:5432/turbine_test',
      'postgresql://u:p@127.0.0.1/app',
    ]) {
      assert.equal(detectPooler(url).pooled, false, url);
    }
  });

  it('a DATABASE named "poolers"', () => {
    // The letters are in the connection string, nowhere near the host. A
    // substring check over the whole string fails exactly here.
    const d = detectPooler('postgres://u:p@db.example.com:5432/poolers');
    assert.equal(d.pooled, false);
    assert.equal(d.host, 'db.example.com');
  });

  it('a ROLE named "pooler_admin" and a password containing "pgbouncer"', () => {
    assert.equal(detectPooler('postgresql://pooler_admin@db.example.com/app').pooled, false);
    assert.equal(detectPooler('postgresql://u:pgbouncer@db.example.com/app').pooled, false);
  });

  it('a host that merely contains the letters ("spooler", "mypool")', () => {
    assert.equal(detectPooler('postgres://u:p@spooler.internal:5432/app').pooled, false);
    assert.equal(detectPooler('postgres://u:p@mypool.example.com:5432/app').pooled, false);
    assert.equal(detectPooler('postgres://u:p@carpooler.example.com:5432/app').pooled, false);
  });

  it('a unix socket and an unparseable string are "no evidence", not a match', () => {
    assert.equal(detectPooler('postgresql:///dbname?host=/var/run/postgresql').pooled, false);
    assert.equal(detectPooler('').pooled, false);
    assert.equal(detectPooler('not a connection string at all').pooled, false);
  });
});

describe('detectPooler - the direct-host hint', () => {
  it('derives the direct host from an in-label "-pooler" suffix', () => {
    const d = detectPooler('postgresql://u:p@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/db');
    assert.equal(d.directHost, 'ep-cool-darkness-123456.us-east-2.aws.neon.tech');
  });

  it('does NOT guess when the token is a whole label', () => {
    // Stripping the label would print "aws-0-us-east-1.supabase.com", which is
    // not the direct endpoint and does not resolve. Better to say nothing.
    const d = detectPooler('postgres://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres');
    assert.equal(d.pooled, true);
    assert.equal(d.directHost, null);
  });

  it('does not guess for a port-only match', () => {
    assert.equal(detectPooler('postgres://u:p@10.0.0.4:6543/app').directHost, null);
  });
});

describe('parseConnectionTarget', () => {
  it('reads host and port from both connection-string forms', () => {
    assert.deepEqual(parseConnectionTarget('postgres://u:p@Db.Example.COM:6543/app'), {
      host: 'db.example.com',
      port: 6543,
    });
    assert.deepEqual(parseConnectionTarget('host=Db.Example.COM port=6543 dbname=app'), {
      host: 'db.example.com',
      port: 6543,
    });
    assert.deepEqual(parseConnectionTarget('postgres://u:p@db.example.com/app'), {
      host: 'db.example.com',
      port: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The refusal
// ---------------------------------------------------------------------------

describe('poolerRefusalMessage', () => {
  const opts = { command: 'turbine doctor', allowFlag: '--allow-pooler' };

  it('names the endpoint, the reason, the fix, and the override', () => {
    const text = poolerRefusalMessage(
      detectPooler('postgresql://u:p@ep-abc-123-pooler.us-east-2.aws.neon.tech/db'),
      opts,
    ).join('\n');

    assert.match(text, /turbine doctor refuses to run through a connection pooler\./);
    assert.match(text, /ep-abc-123-pooler\.us-east-2\.aws\.neon\.tech/);
    assert.match(text, /the hostname contains "pooler"/);
    // The mechanism, not just the verdict.
    assert.match(text, /multiplexes many clients onto a few shared/);
    assert.match(text, /Session state is not private/);
    // The actionable half: the direct endpoint, spelled out when derivable.
    assert.match(text, /Use the DIRECT \(non-pooled\) endpoint/);
    assert.match(text, /-> ep-abc-123\.us-east-2\.aws\.neon\.tech/);
    assert.match(text, /re-run with --allow-pooler/);
  });

  it('gives provider-shaped guidance when the direct host cannot be derived', () => {
    const text = poolerRefusalMessage(detectPooler('postgres://u:p@10.0.0.4:6543/app'), opts).join('\n');
    assert.match(text, /port 6543 is a transaction-pooling port/);
    assert.match(text, /"direct" or "session" connection string/);
    // No invented hostname anywhere.
    assert.doesNotMatch(text, /-> /);
  });
});

/** Run `refusePoolerConnection`, capturing stderr and any `process.exit`. */
function runGuard(url: string, args: Partial<CliArgs> = {}): { exited: number | null; stderr: string } {
  const originalError = console.error;
  const originalExit = process.exit;
  const out: string[] = [];
  let exited: number | null = null;
  // A unique SENTINEL, deliberately not an Error subclass. The stubbed
  // `process.exit` has to unwind the stack somehow, but declaring a local
  // `class Exited extends Error {}` trips `npm run check:error-codes`, whose
  // job is to catch a new error class that should have been a coded
  // TurbineError. That gate is right and this is not an error, so the fix
  // belongs here rather than on the gate's allowlist.
  const EXITED = Symbol('process.exit called');
  console.error = (...parts: unknown[]) => {
    out.push(parts.map(String).join(' '));
  };
  process.exit = ((code?: number) => {
    exited = code ?? 0;
    throw EXITED;
  }) as unknown as typeof process.exit;
  try {
    refusePoolerConnection(url, args as CliArgs);
  } catch (err) {
    if (err !== EXITED) throw err;
  } finally {
    console.error = originalError;
    process.exit = originalExit;
  }
  return { exited, stderr: out.join('\n') };
}

describe('turbine doctor refuses a pooler connection', () => {
  it('exits non-zero on a pooled endpoint, with the refusal on STDERR', () => {
    const { exited, stderr } = runGuard('postgresql://u:p@ep-abc-123-pooler.us-east-2.aws.neon.tech/db');
    assert.equal(exited, 1, 'doctor must refuse, not warn');
    assert.match(stderr, /refuses to run through a connection pooler/);
    assert.match(stderr, /--allow-pooler/);
  });

  it('refuses a port-6543 endpoint and a pgbouncer host too', () => {
    assert.equal(runGuard('postgres://u:p@10.0.0.4:6543/app').exited, 1);
    assert.equal(runGuard('postgres://u:p@pgbouncer.internal:5432/app').exited, 1);
  });

  it('runs normally against a direct endpoint', () => {
    const { exited, stderr } = runGuard('postgres://u:p@db.example.com:5432/poolers');
    assert.equal(exited, null, 'a direct endpoint must not be refused');
    assert.equal(stderr, '');
  });

  it('--allow-pooler is the documented escape hatch, and the default is refusal', () => {
    const url = 'postgresql://u:p@ep-abc-123-pooler.us-east-2.aws.neon.tech/db';
    assert.equal(runGuard(url, { allowPooler: true }).exited, null);
    assert.equal(runGuard(url, {}).exited, 1);
  });
});

describe('the refusal happens before anything connects', () => {
  const CLI_SOURCE = readFileSync(resolve(__dirname, '../cli/index.ts'), 'utf-8');

  it('--allow-pooler is wired into parseArgs and the doctor help', () => {
    assert.ok(CLI_SOURCE.includes("case '--allow-pooler':"), 'parseArgs must handle --allow-pooler');
    assert.ok(CLI_SOURCE.includes("cyan('--allow-pooler')"), 'doctor --help must document --allow-pooler');
  });

  it('cmdDoctor calls the guard ahead of introspect and the statistics collector', () => {
    const start = CLI_SOURCE.indexOf('async function cmdDoctor(');
    assert.ok(start > 0, 'cmdDoctor must exist');
    const body = CLI_SOURCE.slice(start, CLI_SOURCE.indexOf('\n}\n', start));

    const guard = body.indexOf('refusePoolerConnection(');
    const introspect = body.indexOf('await introspect(');
    const stats = body.indexOf('collectStatsSnapshot(');
    assert.ok(guard > 0, 'cmdDoctor must call refusePoolerConnection');
    assert.ok(introspect > 0 && stats > 0, 'cmdDoctor must still introspect and collect stats');
    assert.ok(guard < introspect, 'the guard must run before the first connection (introspect)');
    assert.ok(guard < stats, 'the guard must run before the statistics collector');
  });
});

// ---------------------------------------------------------------------------
// 3. No session-level SET
// ---------------------------------------------------------------------------

describe('withStatementTimeoutOption', () => {
  it('sets the GUC as a connection parameter, not a statement', () => {
    const out = withStatementTimeoutOption({ connectionString: 'postgres://u:p@h/db' }, 5000);
    assert.equal(out.connectionString, 'postgres://u:p@h/db');
    assert.equal(out.options, '-c statement_timeout=5000');
  });

  it('appends to an existing ?options= rather than replacing it', () => {
    const out = withStatementTimeoutOption(
      { connectionString: 'postgres://u:p@h/db?sslmode=require&options=-c%20search_path%3Dfoo' },
      2500,
    );
    const params = new URLSearchParams(out.connectionString.slice(out.connectionString.indexOf('?') + 1));
    assert.equal(params.get('options'), '-c search_path=foo -c statement_timeout=2500');
    assert.equal(params.get('sslmode'), 'require');
    // pg lets the connection-string value override the field, so the field must
    // stay unset in this branch.
    assert.equal(out.options, undefined);
  });

  it('appends to an explicit options field rather than replacing it', () => {
    const out = withStatementTimeoutOption(
      { connectionString: 'postgres://u:p@h/db', options: '-c search_path=foo' },
      1000,
    );
    assert.equal(out.options, '-c search_path=foo -c statement_timeout=1000');
  });

  it('falls back to PGOPTIONS without dropping it', () => {
    const saved = process.env.PGOPTIONS;
    process.env.PGOPTIONS = '-c search_path=deploy';
    try {
      const out = withStatementTimeoutOption({ connectionString: 'postgres://u:p@h/db' }, 1000);
      assert.equal(out.options, '-c search_path=deploy -c statement_timeout=1000');
    } finally {
      if (saved === undefined) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = saved;
    }
  });

  it('refuses a timeout that is not a non-negative integer, rather than emitting it', () => {
    // A GUC value cannot be a bind parameter, so the emitted text is a literal
    // and anything that can carry a space can carry a second `-c`.
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) {
      const out = withStatementTimeoutOption({ connectionString: 'postgres://u:p@h/db' }, bad);
      assert.equal(out.options, undefined, `${bad} must not reach the connection parameters`);
    }
    const injected = withStatementTimeoutOption(
      { connectionString: 'postgres://u:p@h/db' },
      '5000 -c log_statement=all' as unknown as number,
    );
    assert.equal(injected.options, undefined);
  });
});

/**
 * Run `fn` with pg's `Pool` substituted, capturing every config it is
 * constructed with and every statement it is asked to run.
 *
 * `(await import('pg')).default` is the CJS module object, one instance per
 * process, so the collector under test picks up the substitution. Restored in a
 * `finally`; the unit lane runs each test file in its own process anyway.
 */
async function withRecordingPool<T>(
  fn: () => Promise<T>,
): Promise<{ configs: Array<Record<string, unknown>>; statements: string[]; result: T }> {
  const pgModule = (await import('pg')).default as unknown as { Pool: unknown };
  const original = pgModule.Pool;
  const configs: Array<Record<string, unknown>> = [];
  const statements: string[] = [];

  class RecordingPool {
    constructor(config: Record<string, unknown>) {
      configs.push(config);
    }
    async query(text: string): Promise<{ rows: unknown[] }> {
      statements.push(text);
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }

  pgModule.Pool = RecordingPool;
  try {
    const result = await fn();
    return { configs, statements, result };
  } finally {
    pgModule.Pool = original;
  }
}

describe('the statistics collectors issue no session-level SET', () => {
  const url = 'postgres://u:p@db.example.com:5432/app';

  it('collectStatsSnapshot bounds itself with a connection parameter', async () => {
    const saved = process.env.PGOPTIONS;
    delete process.env.PGOPTIONS;
    try {
      const { configs, statements } = await withRecordingPool(() =>
        collectStatsSnapshot({
          connectionString: url,
          schema: 'public',
          tables: ['users'],
          columns: [{ table: 'users', column: 'org_id' }],
          distributionColumns: [{ table: 'users', column: 'org_id' }],
        }),
      );

      assert.equal(configs.length, 1, 'one pool');
      assert.equal(configs[0]?.options, '-c statement_timeout=5000');
      assert.equal(configs[0]?.connectionString, url);
      assert.equal(configs[0]?.max, 1, 'still a one-connection pool');

      assert.ok(statements.length > 0, 'the collector must still read something');
      for (const text of statements) {
        assert.doesNotMatch(
          text,
          /^\s*SET\s/i,
          `a session-level SET reached the wire: ${text.slice(0, 60)}. Through a transaction pooler this ` +
            'attaches to a shared backend that is handed to another client.',
        );
      }
    } finally {
      if (saved !== undefined) process.env.PGOPTIONS = saved;
    }
  });

  it('collectTableHeat bounds itself with a connection parameter', async () => {
    const saved = process.env.PGOPTIONS;
    delete process.env.PGOPTIONS;
    try {
      const { configs, statements } = await withRecordingPool(() =>
        collectTableHeat({ connectionString: url, models: ['users'], statementTimeoutMs: 2000 }),
      );

      assert.equal(configs[0]?.options, '-c statement_timeout=2000');
      assert.equal(configs[0]?.max, 1);
      for (const text of statements) assert.doesNotMatch(text, /^\s*SET\s/i);
    } finally {
      if (saved !== undefined) process.env.PGOPTIONS = saved;
    }
  });
});

/**
 * Strip comments so prose ABOUT the forbidden statement does not read as the
 * statement. Block comments and whole-line `//` / ` *` lines only, which is
 * every comment shape in the two files scanned.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

describe('static guard: no session-scoped SET in the statistics readers', () => {
  // Every string or template literal that OPENS with a SQL `SET`. A
  // transaction-local `SET LOCAL` is fine and is excluded by name.
  const SESSION_SET = /["'`]\s*SET\s+(?!LOCAL\b)/g;

  it('src/index-stats.ts contains no SET statement at all', () => {
    const source = stripComments(readFileSync(resolve(__dirname, '../index-stats.ts'), 'utf-8'));
    assert.deepEqual(source.match(SESSION_SET) ?? [], []);
  });

  it('src/plan-flip-probe.ts uses only transaction-local SET LOCAL', () => {
    const source = stripComments(readFileSync(resolve(__dirname, '../plan-flip-probe.ts'), 'utf-8'));
    assert.deepEqual(source.match(SESSION_SET) ?? [], []);
    // ...and the timeout it used to SET is now transaction-local, INSIDE the
    // transaction, in the parameterizable form (`SET LOCAL x = $1` is a syntax
    // error in Postgres, which is the 0.17.0 bug this shape exists to avoid).
    assert.match(source, /BEGIN READ ONLY/);
    assert.match(source, /set_config\('statement_timeout', \$1, true\)/);
    const beginAt = source.indexOf('BEGIN READ ONLY');
    const timeoutAt = source.indexOf("set_config('statement_timeout'");
    assert.ok(beginAt < timeoutAt, 'the timeout must be set inside the transaction');
  });
});
