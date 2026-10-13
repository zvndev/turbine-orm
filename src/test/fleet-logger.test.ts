/**
 * The logger: every line Turbine writes reaches `logger` with a stable `code`.
 *
 * - One case per code (`EXPECT` is a `Record<TurbineLogCode, ...>`, so a code
 *   added to log-codes.ts without a case here fails typecheck, and the runtime
 *   key check fails too). Each case drives the real emitter through a recording
 *   logger and asserts the code and the level.
 * - The default logger's console output is the text Turbine printed before the
 *   logger existed. The `console` strings below were captured by running these
 *   same triggers against the build before this change, so they are a snapshot,
 *   not a transcription. The one deliberate difference: a `$listen` loss it will
 *   retry is now `console.warn` (level `warn`) rather than `console.error`.
 * - `{}` silences Turbine; a logger that throws never fails the caller; no log
 *   line carries a bound parameter value, even with `logQueryParams: true`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { generateTypes } from '../generate.js';
import { buildRelationsFromForeignKeys } from '../introspect.js';
import { LOG_CODES, type TurbineLogCode } from '../log-codes.js';
import {
  CLIENT_LOG_CONTEXT,
  type ClientLogContext,
  consoleLogger,
  logTo,
  resolveLogger,
  type TurbineLogEntry,
  type TurbineLogger,
  type TurbineLogLevel,
} from '../logger.js';
import { applyPowdbLinks, powqlSchemaDDL } from '../powdb.js';
import { introspectPowdbDatabase } from '../powdb-introspect.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import { QueryInterface } from '../query/index.js';
import { warnParserOverwrite } from '../query/utils.js';
import { resetWarnOnce } from '../query/warn-registry.js';
import { createSubscription } from '../realtime.js';
import { type FleetModules, fakePool, TRIGGERS } from './fleet-logger-triggers.js';
import { mockTable } from './helpers.js';

const MODULES: FleetModules = {
  TurbineClient,
  QueryInterface,
  createSubscription,
  createPrismaCompatClient,
  powqlSchemaDDL,
  applyPowdbLinks,
  introspectPowdbDatabase,
  buildRelationsFromForeignKeys,
  generateTypes,
  warnParserOverwrite,
  resetWarnOnce,
  mockTable: mockTable as FleetModules['mockTable'],
};

/**
 * Level per code, and either the default logger's console line (its method
 * follows the level) or, for a code whose trigger needs a live database, the
 * integration test file that covers it.
 */
type Expectation = { level: TurbineLogLevel; console: string } | { level: TurbineLogLevel; integration: string };

const EXPECT: Record<TurbineLogCode, Expectation> = {
  'parser-overwrite': {
    level: 'warn',
    console:
      '[turbine] pg type parser for OID 1114 (timestamp) was already customized by something else in this process, and Turbine is replacing it. `pg.types.setTypeParser` is process-global and takes effect immediately for EVERY pg.Pool in the process, including pools that already exist and are already querying, so whatever set that parser will now read this column differently. If yours should win, register it AFTER constructing the client. `utcTimestamps: false` leaves the six temporal OIDs (1114, 1082, 1115, 1182, 1184, 1185) alone entirely. This warning fires under `NODE_ENV=production` too: which parser wins depends on module evaluation order, so a process can be clean in dev and wrong in production from import order alone.',
  },
  'unknown-config-key': {
    level: 'warn',
    console:
      '[turbine] Unknown option "logParams" in the config passed to TurbineClient, it is ignored. Did you mean "logQueryParams"?',
  },
  'plan-cache-mode-ignored': {
    level: 'warn',
    console:
      "[turbine] planCacheMode: 'force_custom_plan' was not applied to the primary: this client was given an external `pool`, whose connection lifecycle the caller owns, so Turbine never opens its connections. Set `plan_cache_mode` in the driver's own connection setup (or run `SET plan_cache_mode = force_custom_plan` on checkout) instead.",
  },
  'prepared-statements-on-pooler': {
    level: 'warn',
    console:
      '[turbine] preparedStatements: true on db-pooler.example.com:6543, which looks like a connection pooler. In transaction mode a pooler runs each transaction on any server connection, so a statement named on one fails on the next ("prepared statement ... does not exist" or "already exists") unless the pooler tracks prepared statements: PgBouncer 1.21+ with max_prepared_statements above 0. If yours does not, leave preparedStatements unset; Turbine then sends unnamed statements to a pooler.',
  },
  'connection-option-ignored': {
    level: 'warn',
    console:
      "[turbine] statementTimeoutMs: 1000 was not applied to the primary: this client was given an external `pool`, whose connections Turbine never opens. Set `statement_timeout` in the driver's own connection setup, or on the role (`ALTER ROLE app SET statement_timeout = '30s'`).",
  },
  'pool-error': { level: 'error', console: '[turbine] Unexpected primary pool error: idle connection terminated' },
  'query-listener-error': { level: 'error', console: '[turbine] Query listener error: Error(listener failed)' },
  'pool-listener-error': { level: 'error', console: '[turbine] poolError listener error: Error(pool listener failed)' },
  'replica-close-error': { level: 'error', console: '[turbine] Error closing replica pool: replica close failed' },
  'external-pool': { level: 'debug', console: '[turbine] Using external pool, 1 tables' },
  'pool-created': { level: 'debug', console: '[turbine] Pool created, max 10 connections, 1 tables' },
  'replicas-configured': { level: 'debug', console: '[turbine] 1 read replica(s) configured (0 owned)' },
  pipeline: { level: 'debug', console: '[turbine] Pipeline: 1 queries, items.findMany' },
  'raw-sql': { level: 'debug', console: '[turbine] Raw SQL: SELECT $1...' },
  'transaction-committed': { level: 'debug', console: '[turbine] Transaction committed' },
  'transaction-rolled-back': { level: 'debug', console: '[turbine] Transaction rolled back' },
  listen: { level: 'debug', console: '[turbine] LISTEN "fleet_chan"' },
  notify: { level: 'debug', console: '[turbine] NOTIFY fleet_chan' },
  'connection-verified': { level: 'debug', console: '[turbine] Connection verified' },
  'disconnect-skipped': {
    level: 'debug',
    console: '[turbine] disconnect() skipped, external primary pool is not owned by Turbine',
  },
  'pool-disconnected': { level: 'debug', console: '[turbine] Pool disconnected' },
  'typed-sql': { level: 'debug', console: '[turbine] Typed SQL: SELECT 1...' },
  'listen-reconnecting': {
    level: 'warn',
    console: '[turbine] $listen "fleet_chan": fleet test socket failure, reconnecting',
  },
  'listen-lost': { level: 'error', console: '[turbine] $listen "fleet_chan": fleet test socket failure' },
  'relation-payload-json': {
    level: 'warn',
    console:
      '[turbine] Relation "posts" on "users" returned a payload that is not valid JSON. This is a bug; please report it with the emitted SQL.',
  },
  'flatten-fallback': {
    level: 'warn',
    console:
      '[turbine] relationLoadStrategy: \'flatten\' did not engage for relation "posts" on "users": it is hasMany, and only a to-one relation can be flattened into a join. It loads via the correlated subquery instead (same rows, same values, different plan).',
  },
  'unindexed-relation': {
    level: 'warn',
    console:
      '[turbine] Relation "posts" on "users" probes "posts"(user_id) which has no covering index, each parent row scans the full table. Fix: CREATE INDEX "idx_posts_user_id" ON "posts" ("user_id"); or run `npx turbine doctor` for a full report.',
  },
  'prisma-compat-unknown-option': {
    level: 'warn',
    console: '[turbine] prisma-compat: unknown option "definitelyNotAnOption" in Item.findMany(), it is ignored.',
  },
  'prisma-compat-native-spelling': {
    level: 'warn',
    console:
      '[turbine] prisma-compat: "offset" is Turbine\'s spelling and is ignored here; prisma-compat takes Prisma\'s "skip". (Item.findMany)',
  },
  'prisma-map-stale': {
    level: 'warn',
    console:
      '[turbine] prisma-compat: src/test/fixtures/fingerprint-schema-stale.prisma has changed since prisma-map.ts was generated, so any model, field, relation or compound-unique added or renamed since then is missing from the compat client. Re-run: turbine migrate-from-prisma',
  },
  'prisma-compat-junction-collision': {
    level: 'warn',
    console:
      '[turbine] prisma-compat: the many-to-many junction table "$transaction" collides with an existing client member of the same name, so no junction accessor was created for it. Reach its rows through the owning model relation (a nested connect / disconnect / set on the related model), or through $queryRaw / $executeRaw.',
  },
  'powdb-link-collision': {
    level: 'warn',
    console:
      '[turbine] powqlSchemaDDL(emitLinks): relation "author" on "posts" collides with a column of the same name; skipping its link declaration (PowDB hard-errors on a link that shadows a column).',
  },
  'powdb-link-drift': {
    level: 'warn',
    console:
      '[turbine] applyPowdbLinks: link "author" on "posts" is already declared with different endpoints (have users on user_id = uuid, want users on user_id = id); leaving it untouched (PowDB has no drop-link DDL).',
  },
  'powdb-introspect-no-primary-key': {
    level: 'warn',
    console:
      '[turbine] PowDB introspection: table "logs" has no non-nullable unique column; primaryKey is [] (single-row operations will fail). Supply a primary key via code-first `defineSchema` metadata if this table needs findUnique/update/delete by id.',
  },
  'introspect-relation-renamed': {
    level: 'warn',
    console:
      '[turbine] Relation name "user" on table "posts" (from FK f) collides with an existing column or relation, using "userRel" instead.',
  },
  'introspect-relation-shadows-json': {
    level: 'warn',
    console:
      '[turbine] Relation "user" on table "posts" (from FK f) shadows the json/jsonb column "user", keeping the historical name for runtime compatibility; the relation is omitted from the generated types. Rename the column to expose it.',
  },
  'generate-relation-shadows-column': {
    level: 'warn',
    console:
      '[turbine] Relation "posts" on table "users" shadows a column field of the same name, omitting it from the generated types. Rename the relation (or the column) to expose it.',
  },
  'introspect-cross-schema-fk': { level: 'warn', integration: 'fleet-logger.integration.test.ts' },
};

const CONSOLE_METHOD: Record<TurbineLogLevel, 'log' | 'info' | 'warn' | 'error'> = {
  debug: 'log',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

interface Logged {
  level: TurbineLogLevel;
  message: string;
  entry: TurbineLogEntry;
}

function recorder(): { logger: TurbineLogger; lines: Logged[] } {
  const lines: Logged[] = [];
  const at =
    (level: TurbineLogLevel) =>
    (message: string, entry: TurbineLogEntry): void => {
      lines.push({ level, message, entry });
    };
  return { logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, lines };
}

/** One console call, rendered the way the snapshot was: an Error argument as `Error(message)`. */
interface ConsoleLine {
  method: 'log' | 'info' | 'warn' | 'error';
  text: string;
}

/** Run `fn` with every console level captured. */
async function captureConsole(fn: () => Promise<unknown>): Promise<ConsoleLine[]> {
  const lines: ConsoleLine[] = [];
  const methods = ['log', 'info', 'warn', 'error'] as const;
  const original = methods.map((k) => console[k]);
  for (const k of methods) {
    console[k] = (...args: unknown[]) => {
      lines.push({
        method: k,
        text: args.map((a) => (a instanceof Error ? `Error(${a.message})` : String(a))).join(' '),
      });
    };
  }
  try {
    await fn();
  } finally {
    methods.forEach((k, i) => {
      console[k] = original[i]!;
    });
  }
  return lines;
}

async function settle(async: boolean | undefined, done: () => boolean): Promise<void> {
  const deadline = Date.now() + (async ? 10_000 : 200);
  while (Date.now() < deadline) {
    if (done()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function runRecorded(code: string, logger: TurbineLogger, lines: Logged[]): Promise<void> {
  const c = TRIGGERS[code]!;
  resetWarnOnce();
  await c.trigger(MODULES, logger);
  await settle(c.async, () => lines.some((l) => l.entry.code === code));
}

describe('logger: every code has a case', () => {
  it('EXPECT covers exactly the codes in log-codes.ts', () => {
    assert.deepEqual(Object.keys(EXPECT).sort(), [...LOG_CODES].sort());
  });

  it('every code that is not integration-only has a trigger, and no trigger is orphaned', () => {
    const unit = LOG_CODES.filter((c) => 'console' in EXPECT[c]).sort();
    assert.deepEqual(Object.keys(TRIGGERS).sort(), unit);
    for (const code of LOG_CODES) {
      const e = EXPECT[code];
      if (!('integration' in e)) continue;
      const text = readFileSync(new URL(`./${e.integration}`, import.meta.url), 'utf8');
      assert.ok(text.includes(`'${code}'`), `${e.integration} must exercise ${code}`);
    }
  });

  it('every code is emitted somewhere in the library', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== 'test') walk(full);
        } else if (name.endsWith('.ts') && name !== 'log-codes.ts') {
          files.push(full);
        }
      }
    };
    walk(root);
    const source = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    const dead = LOG_CODES.filter((code) => !source.includes(`code: '${code}'`));
    assert.deepEqual(dead, [], `codes listed in log-codes.ts that nothing emits: ${dead.join(', ')}`);
  });
});

describe('logger: each code reaches a configured logger', () => {
  for (const code of Object.keys(TRIGGERS) as TurbineLogCode[]) {
    it(code, async () => {
      const { logger, lines } = recorder();
      await runRecorded(code, logger, lines);
      const mine = lines.filter((l) => l.entry.code === code);
      assert.ok(mine.length > 0, `no line with code ${code}; got ${lines.map((l) => l.entry.code).join(', ')}`);
      for (const line of mine) {
        assert.equal(line.level, EXPECT[code].level, `${code} is logged at ${EXPECT[code].level}`);
        assert.ok(!line.message.startsWith('[turbine]'), 'the prefix belongs to the console logger, not the message');
        assert.ok(line.message.length > 0);
      }
    });
  }
});

describe('logger: the default console output is unchanged', () => {
  for (const code of Object.keys(TRIGGERS) as TurbineLogCode[]) {
    it(code, async () => {
      const c = TRIGGERS[code]!;
      const e = EXPECT[code];
      assert.ok('console' in e, `${code} has a unit trigger, so it needs a console snapshot`);
      const expected: ConsoleLine = { method: CONSOLE_METHOD[e.level], text: e.console };
      const lines = await captureConsole(async () => {
        resetWarnOnce();
        await c.trigger(MODULES, undefined);
        await settle(c.async, () => false);
      }).catch((err) => assert.fail(err));
      assert.ok(
        lines.some((l) => l.method === expected.method && l.text === expected.text),
        `expected console.${expected.method}(${JSON.stringify(expected.text)})\ngot:\n${lines
          .map((l) => `console.${l.method}(${JSON.stringify(l.text)})`)
          .join('\n')}`,
      );
    });
  }
});

describe('logger: silencing, failures, levels', () => {
  it('`{}` silences every line', async () => {
    const lines = await captureConsole(async () => {
      for (const [code, c] of Object.entries(TRIGGERS)) {
        resetWarnOnce();
        await c.trigger(MODULES, {}).catch((err: unknown) => assert.fail(`${code}: ${String(err)}`));
      }
      await new Promise((r) => setTimeout(r, 1500));
    });
    assert.deepEqual(lines, []);
  });

  it('a logger that throws never fails the operation that logged', async () => {
    const throwing: TurbineLogger = {
      debug: () => {
        throw new Error('debug sink down');
      },
      warn: () => {
        throw new Error('warn sink down');
      },
      error: () => {
        throw new Error('error sink down');
      },
    };
    for (const code of ['unknown-config-key', 'raw-sql', 'transaction-committed', 'pool-error', 'listen-lost']) {
      resetWarnOnce();
      await TRIGGERS[code]!.trigger(MODULES, throwing);
    }
  });

  it('a missing level is dropped and the others still arrive', async () => {
    const warned: string[] = [];
    resetWarnOnce();
    const db = new TurbineClient(
      {
        pool: fakePool() as never,
        logging: true,
        logParams: true,
        logger: { warn: (_m: string, e: TurbineLogEntry) => warned.push(e.code) },
      } as never,
      { enums: {}, tables: { items: mockTable('items', [{ name: 'id', field: 'id' }]) } },
    );
    await db.raw`SELECT 1`;
    assert.deepEqual(warned, ['unknown-config-key']);
  });

  it('a class-based logger keeps its `this`', async () => {
    class Sink {
      readonly seen: string[] = [];
      warn(_message: string, entry: TurbineLogEntry): void {
        this.seen.push(entry.code);
      }
    }
    const sink = new Sink();
    resetWarnOnce();
    await TRIGGERS['connection-option-ignored']!.trigger(MODULES, sink);
    assert.deepEqual(sink.seen, ['connection-option-ignored']);
  });

  it('logging: false emits no debug line, even to a logger that has debug', async () => {
    const { logger, lines } = recorder();
    const db = new TurbineClient(
      { pool: fakePool() as never, logger },
      {
        enums: {},
        tables: { items: mockTable('items', [{ name: 'id', field: 'id' }]) },
      },
    );
    await db.raw`SELECT 1`;
    await db.$transaction(async () => 1);
    await db.disconnect();
    assert.deepEqual(lines, []);
  });
});

describe('logger: no bound value reaches a log line', () => {
  it('with logQueryParams: true and logging: true, a sentinel param appears in query events and in no log line', async () => {
    const SENTINEL = 'sentinel-7f3a9c-value';
    const { logger, lines } = recorder();
    const db = new TurbineClient(
      { pool: fakePool() as never, logger, logging: true, logQueryParams: true },
      {
        enums: {},
        tables: {
          items: mockTable('items', [
            { name: 'id', field: 'id' },
            { name: 'name', field: 'name', pgType: 'text' },
          ]),
        },
      },
    );
    const eventParams: unknown[] = [];
    db.$on('query', (e) => {
      eventParams.push(...e.params);
      throw new Error('listener down');
    });
    const items = db.table('items');
    await db.raw`SELECT ${SENTINEL}`;
    await db.rawUnsafe('SELECT $1', [SENTINEL]);
    await db.sql`SELECT ${SENTINEL}`;
    await db.pipeline(items.buildFindMany({ where: { name: SENTINEL }, limit: 1 }));
    await db.$transaction(async (tx) => tx.table('items').findMany({ where: { name: SENTINEL }, limit: 1 }));
    await db.$notify('fleet_chan', SENTINEL);
    await items.findMany({ where: { name: SENTINEL }, limit: 1 });
    await db.disconnect();

    assert.ok(eventParams.includes(SENTINEL), 'logQueryParams is on: the events do carry the value');
    assert.ok(lines.length >= 8, `expected the lifecycle lines, got ${lines.length}`);
    const leaks: string[] = [];
    const visit = (value: unknown, path: string, seen: Set<unknown>): void => {
      if (typeof value === 'string') {
        if (value.includes(SENTINEL)) leaks.push(path);
        return;
      }
      if (typeof value !== 'object' || value === null || seen.has(value)) return;
      seen.add(value);
      if (value instanceof Error && value.message.includes(SENTINEL)) leaks.push(`${path}.message`);
      for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`, seen);
    };
    for (const [i, line] of lines.entries()) {
      visit(line.message, `lines[${i}].message`, new Set());
      visit(line.entry, `lines[${i}].entry(${line.entry.code})`, new Set());
    }
    assert.deepEqual(leaks, []);
  });
});

describe('logger: resolveLogger and the console logger', () => {
  it('unset is the console logger; {} and partial loggers are accepted as given', () => {
    assert.equal(resolveLogger(undefined), consoleLogger);
    const empty = {};
    assert.equal(resolveLogger(empty), empty);
    const partial = { warn: () => {} };
    assert.equal(resolveLogger(partial), partial);
    // A real console object, with dozens of other members, is accepted too.
    assert.equal(resolveLogger(console), console);
  });

  for (const [label, value, pattern] of [
    ['null', null, /got null/],
    ['a string', 'console', /got string/],
    ['a number', 42, /got number/],
    ['an array', [], /got an array/],
    ['a non-function level', { warn: 'loud' }, /logger\.warn must be a function/],
    ['a non-function error level', { error: {} }, /logger\.error must be a function/],
  ] as const) {
    it(`refuses ${label} with E003`, () => {
      assert.throws(
        () => resolveLogger(value),
        (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003' && pattern.test(err.message),
      );
    });
  }

  it('the client refuses a bad logger before any other construction work, warnings included', async () => {
    const lines = await captureConsole(async () => {
      resetWarnOnce();
      assert.throws(
        () =>
          new TurbineClient({ pool: fakePool() as never, logger: 'pino', logParams: true } as never, {
            enums: {},
            tables: {},
          }),
        (err: unknown) => err instanceof ValidationError && /Invalid logger option/.test(err.message),
      );
    });
    assert.deepEqual(lines, [], 'the unknown-key warning must not run before the logger is validated');
  });

  it('prefixes, and appends the error only to a message that ends in a colon', async () => {
    const err = new Error('boom');
    const lines = await captureConsole(async () => {
      consoleLogger.debug!('a debug line', { code: 'x' });
      consoleLogger.info!('an info line', { code: 'x' });
      consoleLogger.warn!('Listener failed:', { code: 'x', error: err });
      consoleLogger.error!('Pool failed: boom', { code: 'x', error: err });
    });
    assert.deepEqual(lines, [
      { method: 'log', text: '[turbine] a debug line' },
      { method: 'info', text: '[turbine] an info line' },
      { method: 'warn', text: '[turbine] Listener failed: Error(boom)' },
      { method: 'error', text: '[turbine] Pool failed: boom' },
    ]);
  });

  it('logTo drops a missing level and swallows a throwing one', () => {
    const calls: string[] = [];
    logTo({}, 'warn', 'nothing', { code: 'pool-error' });
    logTo(
      {
        error: () => {
          calls.push('error');
          throw new Error('sink down');
        },
      },
      'error',
      'm',
      { code: 'pool-error' },
    );
    assert.deepEqual(calls, ['error']);
  });
});

describe('logger: the client exposes its log context to wrappers', () => {
  it('under a non-enumerable symbol, shared by $primary()', () => {
    const logger = { warn: () => {} };
    const db = new TurbineClient(
      { pool: fakePool() as never, logger, diagnostics: 'production' },
      {
        enums: {},
        tables: {},
      },
    );
    const ctx = (db as unknown as { [CLIENT_LOG_CONTEXT]: ClientLogContext })[CLIENT_LOG_CONTEXT];
    assert.equal(ctx.logger, logger);
    assert.equal(ctx.diagnostics.mode, 'production');
    assert.ok(!Object.keys(db).includes(String(CLIENT_LOG_CONTEXT)));
    const primary = db.$primary() as unknown as { [CLIENT_LOG_CONTEXT]: ClientLogContext };
    assert.equal(primary[CLIENT_LOG_CONTEXT].logger, logger);
    assert.equal(primary[CLIENT_LOG_CONTEXT].diagnostics, ctx.diagnostics);
  });
});
