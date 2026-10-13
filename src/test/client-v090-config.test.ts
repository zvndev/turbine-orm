/**
 * turbine-orm: client options and argument checks that need no database.
 *
 * Covers what a `TurbineClient` decides before it sends anything: the pool
 * configuration it builds (`statementTimeoutMs`, `maxLifetimeSeconds`), the
 * arguments `raw` / `rawUnsafe` / `$on` / `disconnect` accept, the transaction
 * options it validates before taking a connection (`readOnly`,
 * `sessionContext`, `allowBuiltinSettings`, `timeout`), and the statements a
 * read-only transaction opens with. The live behaviour of each is in the
 * client-v090-*.integration suites.
 *
 * Run: npx tsx --test src/test/client-v090-config.test.ts
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { beforeEach, describe, it } from 'node:test';
import { type PgCompatPool, type PgCompatPoolClient, TransactionClient, TurbineClient } from '../client.js';
import { watchCheckouts } from '../connection-guard.js';
import { statementTimeoutSetting, withStartupSetting } from '../connection-url.js';
import type { EngineClientConfig } from '../engine-config.js';
import { ConnectionError, TurbineErrorCode, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { assertSkipListNames, skipListNamesTable, tableAccessorName } from '../global-filters-config.js';
import { mysqlDialect } from '../mysql.js';
import { powdbDialect } from '../powdb.js';
import { resetWarnOnce } from '../query/warn-registry.js';
import type { SchemaMetadata } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { assertTemplateStrings } from '../typed-sql.js';
import { mockColumn, mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: {
    blog_posts: mockTable('blog_posts', [mockColumn('id', 'id', 'int4'), mockColumn('title', 'title', 'text')]),
  },
  enums: {},
};

const URL_PLAIN = 'postgresql://u:p@localhost:5432/db';

/** The pg.PoolConfig a client built, as pg.Pool records it. */
function poolConfig(db: TurbineClient): { options?: string; connectionString?: string; maxLifetimeSeconds?: number } {
  return (db.pool as unknown as { options: ReturnType<typeof poolConfig> }).options;
}

/** A pool whose one connection records every statement and answers with no rows. */
function recordingPool(): { pool: PgCompatPool; sent: string[]; connects: () => number } {
  const sent: string[] = [];
  let connects = 0;
  const client = {
    query: async (sql: string) => {
      sent.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  } as unknown as PgCompatPoolClient;
  const pool = {
    query: async (sql: string) => {
      sent.push(sql);
      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      connects++;
      return client;
    },
    end: async () => {},
    on: () => {},
  } as unknown as PgCompatPool;
  return { pool, sent, connects: () => connects };
}

function e003(pattern: RegExp) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, TurbineErrorCode.VALIDATION);
    assert.match(err.message, pattern, err.message);
    return true;
  };
}

/** Capture console.warn for the duration of `fn`. */
function captureWarnings(fn: () => void): string[] {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    seen.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return seen;
}

describe('statementTimeoutMs', () => {
  it('is a connection parameter on the pool Turbine opens', () => {
    const cfg = poolConfig(new TurbineClient({ connectionString: URL_PLAIN, statementTimeoutMs: 5000 }, schema));
    assert.equal(cfg.options, '-c statement_timeout=5000');
    assert.equal(cfg.connectionString, URL_PLAIN);
  });

  it('is appended after planCacheMode and after options already on the connection string', () => {
    const url = `${URL_PLAIN}?options=-c%20search_path%3Dapp`;
    const cfg = poolConfig(
      new TurbineClient({ connectionString: url, planCacheMode: 'force_custom_plan', statementTimeoutMs: 250 }, schema),
    );
    const params = new URLSearchParams((cfg.connectionString as string).split('?')[1]);
    assert.equal(
      params.get('options'),
      '-c search_path=app -c plan_cache_mode=force_custom_plan -c statement_timeout=250',
    );
  });

  it('reaches owned read replicas too', () => {
    const db = new TurbineClient(
      { connectionString: URL_PLAIN, replicas: [URL_PLAIN], statementTimeoutMs: 75 },
      schema,
    );
    const replicas = (db as unknown as { ownedReplicaPools: { options: { options?: string } }[] }).ownedReplicaPools;
    assert.equal(replicas[0]?.options.options, '-c statement_timeout=75');
  });

  it('0 is sent (it turns a role-level timeout off), unset sends nothing', () => {
    assert.equal(
      poolConfig(new TurbineClient({ connectionString: URL_PLAIN, statementTimeoutMs: 0 }, schema)).options,
      '-c statement_timeout=0',
    );
    assert.equal(poolConfig(new TurbineClient({ connectionString: URL_PLAIN }, schema)).options, undefined);
  });

  it('refuses anything but a non-negative whole number, before any pool exists', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5000', '5000; -c role=admin', true]) {
      assert.throws(
        () => new TurbineClient({ connectionString: URL_PLAIN, statementTimeoutMs: bad as never }, schema),
        e003(/Invalid statementTimeoutMs/),
        `accepted ${String(bad)}`,
      );
    }
  });

  it('is E017 on an engine without the PostgreSQL setting', () => {
    const { pool } = recordingPool();
    assert.throws(
      () => new TurbineClient({ pool, dialect: mysqlDialect, statementTimeoutMs: 1000 }, schema),
      (err: unknown) => err instanceof UnsupportedFeatureError && /statementTimeoutMs/.test(err.message),
    );
  });

  it('warns once that an external pool does not take it, and still constructs', () => {
    resetWarnOnce('connectionOptionIgnored');
    const { pool } = recordingPool();
    const first = captureWarnings(() => new TurbineClient({ pool, statementTimeoutMs: 1000 }, schema));
    const second = captureWarnings(() => new TurbineClient({ pool, statementTimeoutMs: 1000 }, schema));
    assert.equal(first.length, 1, first.join('\n'));
    assert.match(first[0]!, /statementTimeoutMs: 1000 was not applied/);
    assert.match(first[0]!, /ALTER ROLE/);
    assert.equal(second.length, 0, 'warned twice');
  });
});

describe('connection-url startup settings', () => {
  it('statementTimeoutSetting emits only a narrowed integer', () => {
    assert.equal(statementTimeoutSetting(30000), '-c statement_timeout=30000');
    for (const bad of [-1, 0.5, Number.NaN, 2 ** 60]) assert.equal(statementTimeoutSetting(bad), null);
  });

  it('withStartupSetting appends to the field, to PGOPTIONS, or to the URL, whichever pg reads', () => {
    const saved = process.env.PGOPTIONS;
    try {
      delete process.env.PGOPTIONS;
      assert.equal(withStartupSetting({ connectionString: URL_PLAIN }, '-c a=1').options, '-c a=1');
      assert.equal(withStartupSetting({ options: '-c b=2' }, '-c a=1').options, '-c b=2 -c a=1');
      process.env.PGOPTIONS = '-c c=3';
      assert.equal(withStartupSetting({ connectionString: URL_PLAIN }, '-c a=1').options, '-c c=3 -c a=1');
      const fromUrl = withStartupSetting({ connectionString: `${URL_PLAIN}?options=-c%20d%3D4` }, '-c a=1');
      assert.equal(fromUrl.options, undefined);
      assert.equal(new URLSearchParams(fromUrl.connectionString!.split('?')[1]).get('options'), '-c d=4 -c a=1');
    } finally {
      if (saved === undefined) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = saved;
    }
  });
});

describe('maxLifetimeSeconds', () => {
  it('defaults to 30 minutes on the pools Turbine opens', () => {
    assert.equal(poolConfig(new TurbineClient({ connectionString: URL_PLAIN }, schema)).maxLifetimeSeconds, 1800);
    const db = new TurbineClient({ connectionString: URL_PLAIN, replicas: [URL_PLAIN] }, schema);
    const replicas = (db as unknown as { ownedReplicaPools: { options: { maxLifetimeSeconds?: number } }[] })
      .ownedReplicaPools;
    assert.equal(replicas[0]?.options.maxLifetimeSeconds, 1800);
  });

  it('takes an override, and 0 turns recycling off', () => {
    assert.equal(
      poolConfig(new TurbineClient({ connectionString: URL_PLAIN, maxLifetimeSeconds: 60 }, schema)).maxLifetimeSeconds,
      60,
    );
    assert.equal(
      poolConfig(new TurbineClient({ connectionString: URL_PLAIN, maxLifetimeSeconds: 0 }, schema)).maxLifetimeSeconds,
      0,
    );
  });

  it('refuses a value that is not a non-negative whole number of seconds', () => {
    for (const bad of [-5, 0.25, '60', Number.NaN]) {
      assert.throws(
        () => new TurbineClient({ connectionString: URL_PLAIN, maxLifetimeSeconds: bad as never }, schema),
        e003(/Invalid maxLifetimeSeconds/),
      );
    }
  });

  it('warns once when set on a client with an external pool, never when left at the default', () => {
    resetWarnOnce('connectionOptionIgnored');
    const { pool } = recordingPool();
    assert.deepEqual(
      captureWarnings(() => new TurbineClient({ pool }, schema)),
      [],
    );
    const warned = captureWarnings(() => new TurbineClient({ pool, maxLifetimeSeconds: 10 }, schema));
    assert.equal(warned.length, 1);
    assert.match(warned[0]!, /maxLifetimeSeconds: 10 was not applied/);
  });

  it('is not an engine factory option: the engines own their pools', () => {
    // @ts-expect-error maxLifetimeSeconds is excluded from EngineClientConfig.
    const config: EngineClientConfig = { maxLifetimeSeconds: 10 };
    assert.ok(config);
  });
});

describe('raw / rawUnsafe: only a real tagged template is a template', () => {
  let db: TurbineClient;
  let sent: string[];
  beforeEach(() => {
    const rec = recordingPool();
    sent = rec.sent;
    db = new TurbineClient({ pool: rec.pool }, schema);
  });

  it('refuses an array posing as template strings: a plain array, JSON, an unfrozen copy', async () => {
    const userInput = '1; DROP TABLE blog_posts; --';
    const forged = [
      [`SELECT * FROM blog_posts WHERE id = ${userInput}`],
      JSON.parse(`["SELECT * FROM blog_posts WHERE id = ", ""]`),
      Object.assign([`SELECT ${userInput}`], { raw: [`SELECT ${userInput}`] }),
    ];
    for (const strings of forged) {
      await assert.rejects(
        db.raw(strings as unknown as TemplateStringsArray),
        e003(/raw must be called as a tagged template[\s\S]*rawUnsafe\(text, \.\.\.values\)/),
      );
    }
    assert.deepEqual(sent, [], 'a refused call sent nothing');
  });

  it('a real tagged template binds its values', async () => {
    const id = '1 OR 1=1';
    await db.raw`SELECT * FROM blog_posts WHERE id = ${id}`;
    assert.deepEqual(sent, ['SELECT * FROM blog_posts WHERE id = $1']);
  });

  it('db.sql refuses a forged array the same way', () => {
    assert.throws(
      () => db.sql(['SELECT 1'] as unknown as TemplateStringsArray),
      e003(/sql must be called as a tagged template/),
    );
  });

  it('rawUnsafe runs statement text with $N values, and refuses a template or a non-string', async () => {
    await db.rawUnsafe('SELECT * FROM blog_posts WHERE id = $1', 7);
    assert.deepEqual(sent, ['SELECT * FROM blog_posts WHERE id = $1']);
    await assert.rejects(
      db.rawUnsafe(['SELECT 1'] as unknown as string),
      e003(/rawUnsafe takes the statement as a string, not as a tagged template/),
    );
    await assert.rejects(db.rawUnsafe(undefined as unknown as string), e003(/non-empty string, received undefined/));
    await assert.rejects(db.rawUnsafe('   '), e003(/non-empty string/));
  });

  it('assertTemplateStrings names an invalid escape instead of sending "undefined"', () => {
    // A tagged template whose segment has an invalid escape has `undefined` cooked text.
    const tag = (s: TemplateStringsArray) => s;
    const bad = tag`SELECT '\unicode'`;
    assert.throws(() => assertTemplateStrings(bad, 'raw'), e003(/invalid escape sequence/));
  });

  it('assertTemplateStrings names the text-taking method the caller has', () => {
    assert.throws(
      () => assertTemplateStrings(['SELECT 1'], '$queryRaw', '$queryRawUnsafe'),
      e003(/\$queryRaw must be called as a tagged template[\s\S]*`\$queryRawUnsafe\(text, \.\.\.values\)`/),
    );
  });
});

describe('$on / $off event names', () => {
  it('refuses an unknown event instead of registering a listener that never fires', () => {
    const { pool } = recordingPool();
    const db = new TurbineClient({ pool }, schema);
    assert.throws(() => db.$on('pool_error' as 'poolError', () => {}), e003(/unknown event "pool_error"/));
    assert.throws(() => db.$off('querry' as 'query', () => {}), e003(/'query', 'poolError' or 'connectionLost'/));
    db.$on('poolError', () => {});
    db.$on('connectionLost', () => {});
    db.$off('poolError', () => {});
  });
});

describe('disconnect options', () => {
  it('refuses a timeoutMs that is not a non-negative whole number', async () => {
    const { pool } = recordingPool();
    const db = new TurbineClient({ pool }, schema);
    await assert.rejects(db.disconnect({ timeoutMs: -1 }), e003(/Invalid disconnect timeoutMs/));
    assert.deepEqual(await db.disconnect({ timeoutMs: 100 }), { timedOut: false, forcedConnections: 0 });
    assert.equal(await db.disconnect(), undefined);
  });
});

describe('$ping', () => {
  it('rejects with ConnectionError when the database cannot be reached', async () => {
    const db = new TurbineClient(
      { connectionString: 'postgresql://u:p@127.0.0.1:1/db', connectionTimeoutMs: 2000 },
      schema,
    );
    try {
      await assert.rejects(db.$ping(), (err: unknown) => err instanceof ConnectionError);
    } finally {
      await db.disconnect();
    }
  });

  it('times SELECT 1 on a checked-out connection', async () => {
    const { pool, sent } = recordingPool();
    const db = new TurbineClient({ pool }, schema);
    const ms = await db.$ping();
    assert.equal(typeof ms, 'number');
    assert.ok(ms >= 0);
    assert.deepEqual(sent, ['SELECT 1']);
  });
});

describe('transaction options are checked before a connection is taken', () => {
  let rec: ReturnType<typeof recordingPool>;
  let db: TurbineClient;
  beforeEach(() => {
    rec = recordingPool();
    db = new TurbineClient({ pool: rec.pool }, schema);
  });
  it('readOnly opens the transaction read only, with or without an isolation level', async () => {
    await db.$transaction(async () => {}, { readOnly: true });
    await db.$transaction(async () => {}, { readOnly: true, isolationLevel: 'Serializable' });
    await db.$transaction([db.table('blog_posts').buildFindMany()], { readOnly: true });
    assert.deepEqual(
      rec.sent.filter((s) => s.startsWith('BEGIN')),
      ['BEGIN READ ONLY', 'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY', 'BEGIN READ ONLY'],
    );
    await db.$transaction(async () => {}, { readOnly: false });
    assert.equal(rec.sent.filter((s) => s.startsWith('BEGIN')).at(-1), 'BEGIN');
  });

  it('readOnly on MySQL appends READ ONLY to START TRANSACTION, after the isolation level', async () => {
    const my = new TurbineClient({ pool: rec.pool, dialect: mysqlDialect }, schema);
    await my.$transaction(async () => {}, { readOnly: true, isolationLevel: 'RepeatableRead' });
    assert.ok(
      rec.sent.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; START TRANSACTION READ ONLY'),
      rec.sent.join('\n'),
    );
  });

  it('readOnly must be a boolean', async () => {
    await assert.rejects(
      db.$transaction(async () => {}, { readOnly: 'yes' as never }),
      e003(/readOnly must be true or false/),
    );
    assert.equal(rec.connects(), 0);
  });

  it('a sessionContext name without a namespace is refused unless allowed', async () => {
    for (const name of ['role', 'search_path', 'statement_timeout', 'ROLE']) {
      await assert.rejects(
        db.$transaction(async () => {}, { sessionContext: { [name]: 'x' } }),
        e003(
          new RegExp(
            `sessionContext\\["${name}"\\] names a PostgreSQL setting[\\s\\S]*allowBuiltinSettings: \\['${name}'\\]`,
          ),
        ),
      );
    }
    assert.equal(rec.connects(), 0, 'no connection was taken for a refused option');
    await db.$transaction(async () => {}, { sessionContext: { 'app.tenant': 't1' } });
    await db.$transaction(async () => {}, {
      sessionContext: { search_path: 'tenant_1' },
      allowBuiltinSettings: ['SEARCH_PATH'],
    });
    assert.equal(rec.sent.filter((s) => s.includes('set_config')).length, 2);
  });

  it('allowBuiltinSettings must list plain setting names', async () => {
    for (const bad of ['role', ['app.tenant'], ['role; drop'], [1]]) {
      await assert.rejects(
        db.$transaction(async () => {}, { allowBuiltinSettings: bad as never }),
        e003(/allowBuiltinSettings/),
      );
    }
  });

  it('timeout must be a positive number of milliseconds or 0', async () => {
    for (const bad of [-1, Number.NaN, '100', 2 ** 31, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        db.$transaction(async () => {}, { timeout: bad as never }),
        e003(/timeout must be a positive number of milliseconds/),
      );
    }
    assert.equal(rec.connects(), 0);
    await db.$transaction(async () => {}, { timeout: 0 });
  });
});

const HAVE_NODE_SQLITE = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

describe('options an engine has no equivalent for', {
  skip: HAVE_NODE_SQLITE ? false : 'node:sqlite unavailable',
}, () => {
  const SQLITE_SCHEMA = schemaDefToMetadata(
    defineSchema({ items: { id: { type: 'serial', primaryKey: true }, name: { type: 'text', notNull: true } } }),
  );

  it('readOnly is E017 on SQLite rather than an ordinary transaction', async () => {
    const { turbineSqlite } = await import('../sqlite.js');
    const db = turbineSqlite(':memory:', SQLITE_SCHEMA);
    try {
      await assert.rejects(
        db.$transaction(async () => {}, { readOnly: true }),
        (err: unknown) => err instanceof UnsupportedFeatureError && /readOnly/.test(err.message),
      );
    } finally {
      await db.disconnect();
    }
  });

  it('statementTimeoutMs is E017 on SQLite', async () => {
    const { turbineSqlite } = await import('../sqlite.js');
    assert.throws(
      () => turbineSqlite(':memory:', SQLITE_SCHEMA, { statementTimeoutMs: 1000 }),
      (err: unknown) => err instanceof UnsupportedFeatureError,
    );
  });
});

describe('table accessor names', () => {
  it('tableAccessorName is the one camelCase rule', () => {
    assert.equal(tableAccessorName('blog_posts'), 'blogPosts');
    assert.equal(tableAccessorName('users'), 'users');
  });

  it('a skipGlobalFilters list may name a table by its accessor', () => {
    assert.equal(skipListNamesTable(['blogPosts'], 'blog_posts'), true);
    assert.equal(skipListNamesTable(['blog_posts'], 'blog_posts'), true);
    assert.equal(skipListNamesTable(['users'], 'blog_posts'), false);
    // When the accessor spelling is itself another table, it names that table only.
    assert.equal(skipListNamesTable(['blogPosts'], 'blog_posts', { blog_posts: {}, blogPosts: {} }), false);
  });

  it('assertSkipListNames refuses a name that is no table, with the nearest one', () => {
    const tables = { blog_posts: {}, users: {} };
    assertSkipListNames(['blogPosts', 'users', 'blog_posts'], tables);
    assert.throws(
      () => assertSkipListNames(['blogPost'], tables),
      e003(/skipGlobalFilters names "blogPost", which is not a table[\s\S]*Did you mean "blogPosts"/),
    );
    assert.throws(() => assertSkipListNames(['orders'], tables), e003(/"orders", which is not a table/));
  });

  it('every accessor on the client and on a transaction uses it', async () => {
    const { pool } = recordingPool();
    const db = new TurbineClient({ pool }, schema) as TurbineClient & Record<string, unknown>;
    assert.ok('blogPosts' in db);
    await db.$transaction(async (tx) => {
      assert.ok('blogPosts' in tx);
    });
  });
});

describe('watchCheckouts', () => {
  it('tracks checkouts and reports a checked-out connection failing once, an idle one never', () => {
    const pool = new EventEmitter();
    const lost: Error[] = [];
    const watch = watchCheckouts(pool, (err) => lost.push(err));
    const held = new EventEmitter();
    const idle = new EventEmitter();
    pool.emit('connect', held);
    pool.emit('connect', idle);
    pool.emit('acquire', held);
    assert.deepEqual([...watch.checkedOut], [held]);
    held.emit('error', new Error('first'));
    held.emit('error', new Error('second'));
    idle.emit('error', new Error('idle'));
    assert.deepEqual(
      lost.map((e) => e.message),
      ['first'],
    );
    pool.emit('release', undefined, held);
    assert.equal(watch.checkedOut.size, 0);
    pool.emit('acquire', idle);
    pool.emit('remove', idle);
    assert.equal(watch.checkedOut.size, 0);
  });

  it('leaves a pool without events alone', () => {
    assert.equal(watchCheckouts({}).checkedOut.size, 0);
  });
});

describe('tx.$connection() where no driver connection backs the transaction', () => {
  const query = async () => ({ rows: [], rowCount: 0 });
  it('is refused on PowDB, naming what to use instead', () => {
    const tx = new TransactionClient({ query, release() {}, on() {} } as unknown as PgCompatPoolClient, schema, [], {
      dialect: powdbDialect,
    });
    assert.throws(
      () => tx.$connection(),
      (err: unknown) =>
        err instanceof UnsupportedFeatureError && err.dialect === 'powdb' && /tx\.rawUnsafe/.test(err.message),
    );
  });

  it('is refused for a client with no events, which is a stateless HTTP driver', () => {
    const tx = new TransactionClient({ query, release() {} } as unknown as PgCompatPoolClient, schema, []);
    assert.throws(
      () => tx.$connection(),
      (err: unknown) => err instanceof UnsupportedFeatureError && /stateless HTTP driver/.test(err.message),
    );
  });

  it("is the engine pool's client elsewhere, closed with the transaction", () => {
    const tx = new TransactionClient({ query, release() {} } as unknown as PgCompatPoolClient, schema, [], {
      dialect: mysqlDialect,
    });
    const conn = tx.$connection();
    assert.throws(() => conn.release(), ValidationError);
  });
});

describe('preparedStatements on a connection pooler', () => {
  const named = (config: Record<string, unknown>): boolean | undefined =>
    (new TurbineClient(config, schema) as unknown as { queryOptions: { preparedStatements?: boolean } }).queryOptions
      .preparedStatements;

  it('defaults off when the connection string, host settings or a replica name a pooler', () => {
    assert.equal(named({ connectionString: 'postgresql://u@ep-x-pooler.us-east-2.aws.neon.tech/db' }), false);
    assert.equal(named({ connectionString: 'postgresql://u@127.0.0.1:6432/db' }), false);
    assert.equal(named({ host: 'db.internal', port: 6543 }), false);
    assert.equal(
      named({ connectionString: URL_PLAIN, replicas: ['postgresql://u@aws-0-eu.pooler.supabase.com:5432/db'] }),
      false,
    );
    assert.equal(named({ connectionString: URL_PLAIN }), true, 'a direct endpoint keeps named statements');
  });

  it('honours an explicit true and warns once per endpoint', () => {
    resetWarnOnce('preparedStatementsOnPooler');
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      assert.equal(named({ connectionString: 'postgresql://u@127.0.0.1:6432/db', preparedStatements: true }), true);
      named({ connectionString: 'postgresql://u@127.0.0.1:6432/db', preparedStatements: true });
      named({ connectionString: URL_PLAIN, preparedStatements: true });
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0] as string, /127\.0\.0\.1:6432, which looks like a connection pooler/);
  });
});
