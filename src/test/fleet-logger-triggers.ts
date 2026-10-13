/**
 * One trigger per log code: the smallest real call that makes Turbine emit that
 * line. Shared by fleet-logger.test.ts (recording logger, and the default
 * console output) and by a harness that runs the same triggers against an
 * older build to capture the console text the default logger must keep.
 *
 * A trigger takes the modules it drives as a parameter, so the harness can
 * hand it another build's modules. With `logger` undefined it passes no
 * `logger` key at all, so an older build sees exactly the call it always did.
 */

import { EventEmitter } from 'node:events';
import pg from 'pg';
import type { TurbineLogger } from '../logger.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';

// biome-ignore lint/suspicious/noExplicitAny: the harness hands in another build's modules
type Any = any;

/** The modules the triggers call, by the names the package exports them under. */
export interface FleetModules {
  TurbineClient: Any;
  QueryInterface: Any;
  createSubscription: Any;
  createPrismaCompatClient: Any;
  powqlSchemaDDL: Any;
  applyPowdbLinks: Any;
  introspectPowdbDatabase: Any;
  buildRelationsFromForeignKeys: Any;
  generateTypes: Any;
  warnParserOverwrite: Any;
  /** The pre-0.90 cache-check env re-arm hook; present only when the harness runs the old build. */
  resetCacheCrossCheckEnv?: () => void;
  resetWarnOnce: (ns?: string) => void;
  mockTable: (
    name: string,
    columns: { name: string; field: string; pgType?: string }[],
    relations?: Record<string, unknown>,
    primaryKey?: string[],
  ) => TableMetadata;
}

export type Trigger = (m: FleetModules, logger: TurbineLogger | undefined) => Promise<void>;

/** A connection that answers every statement with no rows. */
class FakeConn extends EventEmitter {
  readonly queries: string[] = [];
  async query(sql: unknown): Promise<unknown> {
    this.queries.push(typeof sql === 'string' ? sql : String((sql as { text?: string }).text));
    return { rows: [], rowCount: 0, command: 'SELECT', fields: [] };
  }
  release(): void {}
}

/** An external pg-compatible pool that never touches a network. */
export function fakePool(): {
  query: Any;
  connect: () => Promise<FakeConn>;
  end: () => Promise<void>;
  conns: FakeConn[];
} {
  const conns: FakeConn[] = [];
  return {
    query: async () => ({ rows: [], rowCount: 0, command: 'SELECT', fields: [] }),
    connect: async () => {
      const c = new FakeConn();
      conns.push(c);
      return c;
    },
    end: async () => {},
    conns,
  };
}

/** A connection string Turbine opens a pool for but never connects to in these triggers. */
const OWNED_URL = 'postgresql://fleet@127.0.0.1:1/fleet';

const withLogger = (logger: TurbineLogger | undefined, config: Record<string, unknown>): Any =>
  logger ? { ...config, logger } : config;

function itemsSchema(m: FleetModules): SchemaMetadata {
  return {
    enums: {},
    tables: {
      items: m.mockTable('items', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
  };
}

/** users -> posts (hasMany on `user_id`); `posts` has index info but no index on `user_id`. */
function relationSchema(m: FleetModules): SchemaMetadata {
  const users = m.mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
    ],
    {
      posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'user_id', referenceKey: 'id' },
    },
  );
  const posts = m.mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'title', field: 'title', pgType: 'text' },
  ]);
  posts.indexes = [{ name: 'posts_title_idx', columns: ['title'], unique: false, definition: '' }];
  return { enums: {}, tables: { users, posts } };
}

function relationInterface(m: FleetModules, logger: TurbineLogger | undefined, pool: Any = null): Any {
  return new m.QueryInterface(pool, 'users', relationSchema(m), [], logger ? { logger } : {});
}

/** A query interface over `items` (id, name) on a pool that answers every query with no rows. */
function itemsInterface(m: FleetModules, logger: TurbineLogger | undefined, options: Any = {}): Any {
  return new m.QueryInterface(fakePool(), 'items', itemsSchema(m), [], logger ? { ...options, logger } : options);
}

/** users -> posts -> author (users) -> ..., deep enough for the deep-with advice. */
function deepWith(depth: number): Any {
  let clause: Any = true;
  for (let i = depth; i > 0; i--) clause = { with: { [i % 2 === 1 ? 'posts' : 'author']: clause } };
  return clause.with;
}

/** relationSchema plus the back-reference posts.author, for a with tree of any depth. */
function cyclicSchema(m: FleetModules): SchemaMetadata {
  const schema = relationSchema(m);
  schema.tables.posts!.relations.author = {
    type: 'belongsTo',
    name: 'author',
    from: 'posts',
    to: 'users',
    foreignKey: 'user_id',
    referenceKey: 'id',
  } as never;
  return schema;
}

const NO_ROWS = { command: 'SELECT', rowCount: 0, oid: 0, fields: [] };

function compatMap(): Any {
  return {
    enums: {},
    models: {
      Item: {
        table: 'items',
        accessor: 'items',
        fields: { id: 'id', name: 'name' },
        relations: {},
        compoundUniques: {},
      },
    },
  };
}

/** users and tags joined by a junction table whose name collides with a client member. */
function junctionSchema(m: FleetModules): SchemaMetadata {
  const users = m.mockTable('users', [{ name: 'id', field: 'id' }]);
  const tags = m.mockTable('tags', [{ name: 'id', field: 'id' }]);
  const junction = m.mockTable(
    '$transaction',
    [
      { name: 'user_id', field: 'userId' },
      { name: 'tag_id', field: 'tagId' },
    ],
    {},
    ['user_id', 'tag_id'],
  );
  users.relations.tags = {
    type: 'manyToMany',
    name: 'tags',
    from: 'users',
    to: 'tags',
    foreignKey: 'id',
    referenceKey: 'id',
    through: { table: '$transaction', sourceKey: 'user_id', targetKey: 'tag_id' },
  };
  return { enums: {}, tables: { users, tags, $transaction: junction } };
}

/** posts belongsTo users through `user_id`, plus a column whose field is the relation's name. */
function linkSchema(m: FleetModules, collide: boolean): SchemaMetadata {
  const users = m.mockTable('users', [{ name: 'id', field: 'id' }]);
  const posts = m.mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'user_id', field: 'userId' },
      ...(collide ? [{ name: 'author', field: 'author', pgType: 'text' }] : []),
    ],
    {
      author: {
        type: 'belongsTo',
        name: 'author',
        from: 'posts',
        to: 'users',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
    },
  );
  return { enums: {}, tables: { users, posts } };
}

const POST_USER_FK = [
  {
    sourceTable: 'posts',
    sourceColumns: ['user_id'],
    targetTable: 'users',
    targetColumns: ['id'],
    constraintName: 'f',
  },
];

/** The relation name `user` (from `user_id`) is already a column field on `posts`. */
const TAKEN_USER_FIELD = (): Map<string, Set<string>> =>
  new Map([
    ['posts', new Set(['id', 'userId', 'user'])],
    ['users', new Set(['id'])],
  ]);

/**
 * Every phase-1 code. `async` marks a line that lands after the trigger
 * returns (an unawaited file read); the runner polls for it.
 */
export const TRIGGERS: Record<string, { trigger: Trigger; async?: true }> = {
  'untyped-columns': {
    trigger: async (m, logger) => {
      const items = m.mockTable('items', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]) as Any;
      // `name` carries no database type anywhere in the metadata.
      for (const col of items.columns) {
        if (col.name !== 'name') continue;
        delete col.pgType;
        delete col.dialectType;
      }
      delete items.pgTypes.name;
      delete items.dialectTypes.name;
      new m.QueryInterface(null, 'items', { enums: {}, tables: { items } }, [], logger ? { logger } : {});
    },
  },
  'unordered-page': {
    trigger: async (m, logger) => {
      await itemsInterface(m, logger).findMany({ limit: 5, offset: 5 });
    },
  },
  'auto-strategy': {
    trigger: async (m, logger) => {
      await relationInterface(m, logger, fakePool()).findMany({ with: { posts: true }, limit: 1 });
    },
  },
  'deep-with': {
    trigger: async (m, logger) => {
      const qi = new m.QueryInterface(fakePool(), 'users', cyclicSchema(m), [], logger ? { logger } : {});
      await qi.findMany({ with: deepWith(6), limit: 1, relationLoadStrategy: 'join' });
    },
  },
  'flatten-blocked': {
    trigger: async (m, logger) => {
      relationInterface(m, logger).buildFindMany({
        with: { posts: true },
        distinct: ['name'],
        limit: 1,
        relationLoadStrategy: 'flatten',
        jsonEncoding: 'object',
      });
    },
  },
  'redundant-sort-term': {
    trigger: async (m, logger) => {
      itemsInterface(m, logger).buildFindMany({ orderBy: [{ id: 'asc' }, { id: 'desc' }], limit: 1 });
    },
  },
  'unknown-query-option': {
    trigger: async (m, logger) => {
      await itemsInterface(m, logger).findMany({ include: { posts: true }, limit: 1 });
    },
  },
  'unlimited-find-many': {
    trigger: async (m, logger) => {
      await itemsInterface(m, logger).findMany({ orderBy: { id: 'asc' } });
    },
  },
  'temporal-infinity': {
    trigger: async (m, logger) => {
      const events = m.mockTable('events', [
        { name: 'id', field: 'id' },
        { name: 'starts_at', field: 'startsAt', pgType: 'timestamptz' },
      ]) as Any;
      events.dateColumns = new Set(['starts_at']);
      const qi = new m.QueryInterface(null, 'events', { enums: {}, tables: { events } }, [], logger ? { logger } : {});
      qi.buildFindMany({ limit: 1 }).transform({ ...NO_ROWS, rows: [{ id: 1, starts_at: 'infinity' }], rowCount: 1 });
    },
  },
  'cache-mismatch': {
    trigger: async (m, logger) => {
      // The sampled check, on a cache entry corrupted after warming. The
      // environment variables drive the pre-0.90 build; the option drives this one.
      const saved = { NODE_ENV: process.env.NODE_ENV, SAMPLE: process.env.TURBINE_CACHE_CHECK_SAMPLE };
      process.env.NODE_ENV = 'production';
      process.env.TURBINE_CACHE_CHECK_SAMPLE = '1';
      m.resetCacheCrossCheckEnv?.();
      try {
        const options = { diagnostics: { cacheCheck: { sample: 1 } }, ...(logger ? { logger } : {}) };
        const qi = new m.QueryInterface(null, 'items', itemsSchema(m), [], options);
        qi.buildFindMany({ where: { name: 'a' }, limit: 1 });
        const cache = qi.sqlTemplateCache.cache as Map<string, { sql: string }>;
        for (const entry of cache.values()) entry.sql = 'SELECT 1 -- corrupted';
        try {
          qi.buildFindMany({ where: { name: 'b' }, limit: 1 });
        } catch {
          // The throw is the check's other half; the log line is the point here.
        }
      } finally {
        if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = saved.NODE_ENV;
        if (saved.SAMPLE === undefined) delete process.env.TURBINE_CACHE_CHECK_SAMPLE;
        else process.env.TURBINE_CACHE_CHECK_SAMPLE = saved.SAMPLE;
        m.resetCacheCrossCheckEnv?.();
      }
    },
  },
  'stream-idle-timeout': {
    trigger: async (m, logger) => {
      // A stream that overflows one batch takes the cursor path; its consumer
      // takes one row and walks away. The line is logged once the guard has
      // closed the stream and released the connection.
      let released = false;
      const conn = Object.assign(new EventEmitter(), {
        query: async (sql: string) => ({ rows: String(sql).startsWith('FETCH') ? [{ id: 1 }, { id: 2 }] : [] }),
        release: () => {
          released = true;
        },
      });
      const pool = { query: async () => ({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }), connect: async () => conn };
      const qi = new m.QueryInterface(
        pool,
        'items',
        itemsSchema(m),
        [],
        withLogger(logger, { warnOnUnlimited: false }),
      );
      const it = qi.findManyStream({ batchSize: 2, idleTimeoutMs: 20 })[Symbol.asyncIterator]();
      await it.next();
      const deadline = Date.now() + 2000;
      while (!released && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    },
  },
  'sql-comment-dropped': {
    trigger: async (m, logger) => {
      // A dynamic hook returning a key the comment format refuses: the
      // statement still runs, with that key left out and one warning.
      const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
      const qi = new m.QueryInterface(
        pool,
        'items',
        itemsSchema(m),
        [],
        withLogger(logger, { warnOnUnlimited: false, sqlComment: { dynamic: () => ({ 'Trace-Id': 'abc' }) } }),
      );
      await qi.findMany({ limit: 1 });
    },
  },
  'parser-overwrite': {
    trigger: async (m, logger) => {
      // Somebody else's parser on a temporal OID, then the check Turbine runs
      // before replacing it. The original parser is put back either way.
      const types = pg.types as unknown as {
        getTypeParser(oid: number, format: 'text'): (v: string) => unknown;
        setTypeParser(oid: number, parse: (v: string) => unknown): void;
      };
      const original = types.getTypeParser(1114, 'text');
      types.setTypeParser(1114, (v: string) => `custom:${v}`);
      try {
        m.warnParserOverwrite(1114, 'timestamp', logger);
      } finally {
        types.setTypeParser(1114, original);
      }
    },
  },
  'unknown-config-key': {
    trigger: async (m, logger) => {
      new m.TurbineClient(withLogger(logger, { pool: fakePool(), logParams: true }), itemsSchema(m));
    },
  },
  'plan-cache-mode-ignored': {
    trigger: async (m, logger) => {
      new m.TurbineClient(withLogger(logger, { pool: fakePool(), planCacheMode: 'force_custom_plan' }), itemsSchema(m));
    },
  },
  'prepared-statements-on-pooler': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(
        withLogger(logger, {
          connectionString: 'postgresql://fleet@db-pooler.example.com:6543/app',
          preparedStatements: true,
        }),
        itemsSchema(m),
      );
      await db.disconnect();
    },
  },
  'connection-option-ignored': {
    trigger: async (m, logger) => {
      new m.TurbineClient(withLogger(logger, { pool: fakePool(), statementTimeoutMs: 1000 }), itemsSchema(m));
    },
  },
  'pool-error': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { connectionString: OWNED_URL }), itemsSchema(m));
      (db.pool as EventEmitter).emit('error', new Error('idle connection terminated'));
      await db.disconnect();
    },
  },
  'query-listener-error': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { pool: fakePool(), logging: true }), itemsSchema(m));
      db.$on('query', () => {
        throw new Error('listener failed');
      });
      await db.raw`SELECT 1`;
    },
  },
  'pool-listener-error': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(
        withLogger(logger, { connectionString: OWNED_URL, logging: true }),
        itemsSchema(m),
      );
      db.$on('poolError', () => {
        throw new Error('pool listener failed');
      });
      (db.pool as EventEmitter).emit('error', new Error('idle connection terminated'));
      await db.disconnect();
    },
  },
  'replica-close-error': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(
        withLogger(logger, { pool: fakePool(), logging: true, replicas: [OWNED_URL] }),
        itemsSchema(m),
      );
      const replica = (db as { ownedReplicaPools: { end: () => Promise<void> }[] }).ownedReplicaPools[0]!;
      const realEnd = replica.end.bind(replica);
      replica.end = () => realEnd().then(() => Promise.reject(new Error('replica close failed')));
      await db.disconnect();
    },
  },
  'external-pool': {
    trigger: async (m, logger) => {
      new m.TurbineClient(withLogger(logger, { pool: fakePool(), logging: true }), itemsSchema(m));
    },
  },
  'pool-created': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(
        withLogger(logger, { connectionString: OWNED_URL, logging: true }),
        itemsSchema(m),
      );
      await db.disconnect();
    },
  },
  'replicas-configured': {
    trigger: async (m, logger) => {
      new m.TurbineClient(
        withLogger(logger, { pool: fakePool(), logging: true, replicas: [fakePool()] }),
        itemsSchema(m),
      );
    },
  },
  pipeline: {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { pool: fakePool(), logging: true }), itemsSchema(m));
      await db.pipeline(db.table('items').buildFindMany({ limit: 1 }));
    },
  },
  'raw-sql': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { pool: fakePool(), logging: true }), itemsSchema(m));
      await db.raw`SELECT ${1}`;
    },
  },
  'transaction-committed': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { pool: fakePool(), logging: true }), itemsSchema(m));
      await db.$transaction(async () => 1);
    },
  },
  'transaction-rolled-back': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { pool: fakePool(), logging: true }), itemsSchema(m));
      await db
        .$transaction(async () => {
          throw new Error('roll it back');
        })
        .catch(() => undefined);
    },
  },
  listen: {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { pool: fakePool(), logging: true }), itemsSchema(m));
      const sub = await db.$listen('fleet_chan', () => {});
      await sub.unsubscribe();
    },
  },
  notify: {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { pool: fakePool(), logging: true }), itemsSchema(m));
      await db.$notify('fleet_chan', 'payload');
    },
  },
  'connection-verified': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { pool: fakePool(), logging: true }), itemsSchema(m));
      await db.connect();
    },
  },
  'disconnect-skipped': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { pool: fakePool(), logging: true }), itemsSchema(m));
      await db.disconnect();
    },
  },
  'pool-disconnected': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(
        withLogger(logger, { connectionString: OWNED_URL, logging: true }),
        itemsSchema(m),
      );
      await db.disconnect();
    },
  },
  'typed-sql': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { pool: fakePool(), logging: true }), itemsSchema(m));
      await db.sql`SELECT 1`;
    },
  },
  'listen-reconnecting': {
    trigger: async (m, logger) => {
      const pool = fakePool();
      const sub = await m.createSubscription(
        pool,
        'fleet_chan',
        '"fleet_chan"',
        () => {},
        () => {},
        { reconnect: { initialDelayMs: 50 } },
        logger,
      );
      pool.conns[0]!.emit('error', new Error('fleet test socket failure'));
      await sub.unsubscribe();
    },
  },
  'listen-lost': {
    trigger: async (m, logger) => {
      const pool = fakePool();
      await m.createSubscription(
        pool,
        'fleet_chan',
        '"fleet_chan"',
        () => {},
        () => {},
        { reconnect: false },
        logger,
      );
      pool.conns[0]!.emit('error', new Error('fleet test socket failure'));
    },
  },
  'relation-payload-json': {
    trigger: async (m, logger) => {
      const deferred = relationInterface(m, logger).buildFindMany({
        with: { posts: true },
        limit: 1,
        relationLoadStrategy: 'join',
      });
      try {
        deferred.transform({ ...NO_ROWS, rows: [{ id: 1, name: 'a', posts: 'not valid json' }], rowCount: 1 });
      } catch {
        // The refusal is the point of a different test.
      }
    },
  },
  'flatten-fallback': {
    trigger: async (m, logger) => {
      relationInterface(m, logger).buildFindMany({
        with: { posts: true },
        limit: 1,
        relationLoadStrategy: 'flatten',
        jsonEncoding: 'object',
      });
    },
  },
  'unindexed-relation': {
    trigger: async (m, logger) => {
      relationInterface(m, logger).buildFindMany({ with: { posts: true }, limit: 1, relationLoadStrategy: 'join' });
    },
  },
  'prisma-compat-unknown-option': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { pool: fakePool() }), itemsSchema(m));
      await m.createPrismaCompatClient(db, compatMap()).Item.findMany({ take: 1, definitelyNotAnOption: true });
    },
  },
  'prisma-compat-native-spelling': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { pool: fakePool() }), itemsSchema(m));
      await m.createPrismaCompatClient(db, compatMap()).Item.findMany({ take: 1, offset: 0 });
    },
  },
  'prisma-map-stale': {
    async: true,
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { pool: fakePool() }), itemsSchema(m));
      m.createPrismaCompatClient(db, {
        ...compatMap(),
        source: { path: 'src/test/fixtures/fingerprint-schema-stale.prisma', hash: 'v1:ffffffffffffffff' },
      });
    },
  },
  'prisma-compat-junction-collision': {
    trigger: async (m, logger) => {
      const db = new m.TurbineClient(withLogger(logger, { pool: fakePool() }), junctionSchema(m));
      m.createPrismaCompatClient(db, {
        enums: {},
        models: {
          User: {
            table: 'users',
            accessor: 'users',
            fields: { id: 'id' },
            relations: { tags: { name: 'tags', cardinality: 'many' } },
            compoundUniques: {},
          },
        },
      });
    },
  },
  'powdb-link-collision': {
    trigger: async (m, logger) => {
      m.powqlSchemaDDL(linkSchema(m, true), logger ? { emitLinks: true, logger } : { emitLinks: true });
    },
  },
  'powdb-link-drift': {
    trigger: async (m, logger) => {
      const exec = async (powql: string) =>
        powql === 'schema links'
          ? {
              rows: [{ owner: 'posts', name: 'author', target: 'users', local_key: 'user_id', target_key: 'uuid' }],
            }
          : { rows: [] };
      await m.applyPowdbLinks(exec, linkSchema(m, false), logger ? { logger } : {});
    },
  },
  'powdb-introspect-no-primary-key': {
    trigger: async (m, logger) => {
      const exec = async (powql: string) => {
        if (powql === 'schema') return { rows: [{ name: 'logs', columns: 1 }] };
        if (/^describe `?logs`?$/.test(powql)) {
          return { rows: [{ column: 'line', type: 'str', nullable: 'true', index: '' }] };
        }
        return { rows: [] };
      };
      await m.introspectPowdbDatabase(exec, logger ? { logger } : {});
    },
  },
  'introspect-relation-renamed': {
    trigger: async (m, logger) => {
      m.buildRelationsFromForeignKeys(POST_USER_FK, TAKEN_USER_FIELD(), undefined, undefined, undefined, logger);
    },
  },
  'introspect-relation-shadows-json': {
    trigger: async (m, logger) => {
      m.buildRelationsFromForeignKeys(
        POST_USER_FK,
        TAKEN_USER_FIELD(),
        undefined,
        new Map([['posts', new Set(['user'])]]),
        undefined,
        logger,
      );
    },
  },
  'generate-relation-shadows-column': {
    trigger: async (m, logger) => {
      const users = m.mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'posts', field: 'posts', pgType: 'text' },
        ],
        {
          posts: {
            type: 'hasMany',
            name: 'posts',
            from: 'users',
            to: 'posts',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
        },
      );
      const posts = m.mockTable('posts', [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
      ]);
      m.generateTypes({ enums: {}, tables: { users, posts } }, logger ? { logger } : undefined);
    },
  },
};
