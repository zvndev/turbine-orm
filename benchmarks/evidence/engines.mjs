import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { TurbineClient } from '../../src/client.ts';
import { defineSchema } from '../../src/schema-builder.ts';
import { schemaDefToMetadata } from '../../src/schema-metadata.ts';
import { turbineSqlite } from '../../src/sqlite.ts';
import { MysqlPool, turbineMysql } from '../../src/mysql.ts';
import { MssqlPool, turbineMssql } from '../../src/mssql.ts';
import { auditMysqlNative, rawMysqlDrain } from './mysql-native.mjs';
import { assertPgRoute } from './pg-native.mjs';
import { BATCH_SIZE, digest, FIXTURE, scratchName } from './workload.mjs';

const columns = 'id, label, value, note';
const table = 'evidence_items';
const metadata = schemaDefToMetadata(defineSchema({
  evidence_items: {
    id: { type: 'integer', primaryKey: true },
    label: { type: 'text' }, value: { type: 'integer' }, note: { type: 'text', nullable: true },
  },
}));
const options = { logging: false, warnOnUnlimited: false, diagnostics: { cacheCheck: 'off' } };

export function adminUrl(engine, env = process.env) {
  const variable = { postgresql: 'EVIDENCE_PG_ADMIN_URL', mysql: 'EVIDENCE_MYSQL_ADMIN_URL', mssql: 'EVIDENCE_MSSQL_ADMIN_URL' }[engine];
  if (!env[variable]) return { unavailable: `${variable} unset; no server provisioned or certified` };
  if (env.EVIDENCE_DISPOSABLE !== '1') throw new Error('Configured servers require EVIDENCE_DISPOSABLE=1 (scratch database creation/deletion)');
  const url = new URL(env[variable]);
  const protocol = { postgresql: ['postgres:', 'postgresql:'], mysql: ['mysql:'], mssql: ['mssql:'] }[engine];
  if (!protocol.includes(url.protocol)) throw new Error(`Wrong protocol for ${variable}`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Evidence services must be explicit loopback disposable endpoints');
  if (url.search || url.hash) throw new Error('Evidence admin URLs must not contain query parameters or fragments');
  return { url };
}

function bind(engine, count) {
  return Array.from({ length: count }, (_, i) => engine === 'postgresql' ? `$${i + 1}` : engine === 'mssql' ? `@p${i + 1}` : '?').join(', ');
}

export async function openEngine(engine, env = process.env) {
  const cleanup = [];
  const name = scratchName(`turbine_evidence_${randomBytes(8).toString('hex')}`);
  const context = { engine, name, unavailableArms: [], trace: [], serverPid: null };
  context.close = async () => {
    const failures = [];
    for (const fn of cleanup.reverse()) {
      try { await fn(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Evidence scratch cleanup failed');
  };
  try {
    if (engine === 'sqlite') {
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < 24 || (major === 24 && minor < 10)) return { unavailable: 'This evidence package requires Node >=24.10 for the matched SQLite adapters; library support has a separate floor' };
      let DatabaseSync;
      try { ({ DatabaseSync } = await import('node:sqlite')); }
      catch { return { unavailable: 'node:sqlite unavailable; Node >=24.10 required by this harness' }; }
      const directory = mkdtempSync(join(tmpdir(), 'turbine-evidence-'));
      cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
      const raw = new DatabaseSync(join(directory, 'fixture.sqlite'));
      cleanup.push(() => raw.close());
      raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      context.native = raw;
      context.query = async (sql, values = []) => {
        const statement = raw.prepare(sql);
        return /^(SELECT|PRAGMA)/i.test(sql) ? statement.all(...values) : statement.run(...values);
      };
      context.exec = async (sql) => raw.exec(sql);
      context.rawTransaction = async (fn) => {
        raw.exec('BEGIN');
        try { const value = await fn(context.query); raw.exec('COMMIT'); return value; }
        catch (error) { raw.exec('ROLLBACK'); throw error; }
      };
      context.turbine = turbineSqlite(raw, metadata, options);
      context.version = (await context.query('SELECT sqlite_version() AS version'))[0].version;
      context.settings = { journalMode: (await context.query('PRAGMA journal_mode'))[0].journal_mode,
        synchronous: (await context.query('PRAGMA synchronous'))[0].synchronous, foreignKeys: 1 };
    } else {
      const configured = adminUrl(engine, env);
      if (configured.unavailable) return configured;
      const url = configured.url;
      if (engine === 'postgresql') {
        const admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000, query_timeout: 30000 });
        await admin.connect();
        cleanup.push(() => admin.end());
        await admin.query(`CREATE DATABASE "${name}"`);
        cleanup.push(async () => { await admin.query(`DROP DATABASE "${scratchName(name)}"`); });
        url.pathname = `/${name}`;
        const pool = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000, query_timeout: 30000 });
        cleanup.push(() => pool.end());
        context.native = pool;
        context.query = async (sql, values = []) => (await pool.query(sql, values)).rows;
        context.exec = context.query;
        context.rawTransaction = async (fn) => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            try { const result = await fn(async (sql, values = []) => (await client.query(sql, values)).rows); await client.query('COMMIT'); return result; }
            catch (error) { await client.query('ROLLBACK'); throw error; }
          } finally { client.release(); }
        };
        context.turbine = new TurbineClient({ ...options, pool }, metadata);
        context.version = (await context.query('SHOW server_version'))[0].server_version;
        context.settings = (await context.query("SELECT current_setting('transaction_isolation') AS isolation, current_setting('synchronous_commit') AS synchronous_commit, current_setting('fsync') AS fsync, current_setting('timezone') AS timezone"))[0];
        context.serverPid = (await context.query('SELECT pg_backend_pid() AS pid'))[0].pid;
        // Container backend PIDs are not host PIDs. Refuse attribution unless
        // this host process identifies the exact random scratch database.
        try {
          const command = readFileSync(`/proc/${context.serverPid}/cmdline`, 'utf8');
          if (!command.includes(name) || !command.includes('postgres')) context.serverPid = null;
        } catch { context.serverPid = null; }
      } else if (engine === 'mysql') {
        const { default: mysql } = await import('mysql2/promise');
        const config = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password), database: url.pathname.slice(1) || undefined,
          connectionLimit: 1, connectTimeout: 5000, namedPlaceholders: true, supportBigNumbers: true, bigNumberStrings: false, timezone: 'Z' };
        const admin = await mysql.createConnection(config);
        cleanup.push(() => admin.end());
        await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
        cleanup.push(() => admin.query(`DROP DATABASE \`${scratchName(name)}\``));
        const pool = mysql.createPool({ ...config, database: name });
        cleanup.push(() => pool.end());
        context.native = pool;
        context.query = async (sql, values = []) => (await pool.query(sql, values))[0];
        context.exec = context.query;
        context.rawTransaction = async (fn) => {
          const client = await pool.getConnection();
          try {
            await client.beginTransaction();
            try { const result = await fn(async (sql, values = []) => (await client.query(sql, values))[0]); await client.commit(); return result; }
            catch (error) { await client.rollback(); throw error; }
          } finally { client.release(); }
        };
        context.turbine = await turbineMysql(new MysqlPool(pool), metadata, options);
        context.version = (await context.query('SELECT VERSION() AS version'))[0].version;
        context.settings = (await context.query('SELECT @@transaction_isolation AS isolation, @@innodb_flush_log_at_trx_commit AS flush_log, @@character_set_database AS charset, @@collation_database AS collation, @@sql_mode AS sql_mode, @@autocommit AS autocommit, @@log_bin AS log_bin'))[0];
      } else {
        const { default: sql } = await import('mssql');
        const config = { server: url.hostname, port: Number(url.port || 1433), user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password), database: url.pathname.slice(1) || 'master',
          connectionTimeout: 5000, requestTimeout: 30000,
          options: { encrypt: false, trustServerCertificate: true }, pool: { max: 1, min: 0 } };
        const admin = await new sql.ConnectionPool(config).connect();
        cleanup.push(() => admin.close());
        await admin.request().query(`CREATE DATABASE [${name}]`);
        cleanup.push(() => admin.request().query(`DROP DATABASE [${scratchName(name)}]`));
        const pool = await new sql.ConnectionPool({ ...config, database: name }).connect();
        cleanup.push(() => pool.close());
        context.native = pool;
        context.sql = sql;
        const queryOn = async (owner, text, values = []) => {
          const request = owner.request();
          values.forEach((value, i) => request.input(`p${i + 1}`, value));
          return (await request.query(text)).recordset ?? [];
        };
        context.query = (text, values) => queryOn(pool, text, values);
        context.exec = context.query;
        context.rawTransaction = async (fn) => {
          const transaction = new sql.Transaction(pool);
          await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
          try { const result = await fn((text, values) => queryOn(transaction, text, values)); await transaction.commit(); return result; }
          catch (error) { await transaction.rollback(); throw error; }
        };
        context.turbine = await turbineMssql(new MssqlPool(pool, sql), metadata, options);
        context.version = (await context.query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS varchar(100)) AS version"))[0].version;
        context.settings = (await context.query('SELECT compatibility_level, is_read_committed_snapshot_on, is_delayed_durability_on = CASE delayed_durability WHEN 0 THEN 0 ELSE 1 END FROM sys.databases WHERE name = DB_NAME()'))[0];
      }
    }
    cleanup.push(() => context.turbine.disconnect());
    const text = engine === 'mssql' ? 'NVARCHAR(200)' : engine === 'mysql' ? 'VARCHAR(200)' : 'TEXT';
    await context.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label ${text} NOT NULL, value INTEGER NOT NULL, note ${text} NULL)`);
    await context.rawTransaction(async (query) => {
      for (const row of FIXTURE) await query(`INSERT INTO ${table} (${columns}) VALUES (${bind(engine, 4)})`, Object.values(row));
    });
    context.all = () => context.query(`SELECT ${columns} FROM ${table} ORDER BY id ASC`);
    context.reset = async () => {
      await context.rawTransaction(async (query) => {
        for (const row of FIXTURE.slice(0, 2)) await query(`UPDATE ${table} SET value=${bind(engine, 1)} WHERE id=${engine === 'postgresql' ? '$2' : engine === 'mssql' ? '@p2' : '?'}`, [row.value, row.id]);
      });
    };
    context.arms = [rawArm(context), turbineArm(context)];
    for (const alias of ['drizzle-stable', 'drizzle-candidate']) {
      if (engine === 'mssql' && alias === 'drizzle-stable') {
        context.unavailableArms.push({ arm: alias, reason: 'No SQL Server adapter in stable Drizzle; never substituted with raw SQL' });
      } else context.arms.push(await drizzleArm(context, alias));
    }
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

function rawArm(context) {
  const { engine, query } = context;
  return {
    name: 'raw', adapter: engine === 'sqlite' ? 'node:sqlite' : engine === 'postgresql' ? 'pg' : engine === 'mysql' ? 'mysql2' : 'mssql',
    page: () => query(`SELECT ${columns} FROM ${table} WHERE id > ${bind(engine, 1)} AND id <= ${engine === 'postgresql' ? '$2' : engine === 'mssql' ? '@p2' : '?'} ORDER BY id ASC`, [16, 80]),
    point: (round) => query(`SELECT ${columns} FROM ${table} WHERE id = ${bind(engine, 1)}`, [round % 16 + 1]),
    transaction: (rollback = false) => context.rawTransaction(async (tx) => {
      for (const id of [1, 2]) await tx(`UPDATE ${table} SET value=value+1 WHERE id=${bind(engine, 1)}`, [id]);
      const result = await tx(`SELECT ${columns} FROM ${table} ORDER BY id ASC`);
      if (rollback) throw new Error('evidence rollback control');
      return result;
    }),
    ...(engine === 'sqlite' ? {
      native: async (_round, sample) => context.rawTransaction(async () => {
        const sink = digest();
        let n = 0;
        for (const row of context.native.prepare(`SELECT ${columns} FROM ${table} ORDER BY id ASC`).iterate()) {
          sink.row(row);
          if (++n % BATCH_SIZE === 0) sample();
        }
        return sink.finish();
      }),
      nativeContract: 'node:sqlite iterate(), BEGIN/COMMIT, one handle; sampled every 128 rows',
    } : engine === 'postgresql' ? {
      native: async (_round, sample) => context.rawTransaction(async (tx) => {
        const sink = digest();
        await tx(`DECLARE evidence_cursor NO SCROLL CURSOR FOR SELECT ${columns} FROM ${table} ORDER BY id ASC`);
        try {
          for (;;) {
            const rows = await tx(`FETCH ${BATCH_SIZE} FROM evidence_cursor`);
            for (const row of rows) sink.row(row);
            sample();
            if (rows.length < BATCH_SIZE) break;
          }
        } finally { await tx('CLOSE evidence_cursor'); }
        return sink.finish();
      }),
      nativeContract: 'pg transaction cursor; FETCH 128; no speculative read; one max=1 pool',
    } : engine === 'mysql' ? {
      native: (_round, sample) => rawMysqlDrain(context.native, sample),
      nativeContract: 'mysql2 callback Query.stream highWaterMark=1; ordered digest; BEGIN/COMMIT; same max=1 pool',
    } : {}),
  };
}

function turbineArm(context) {
  const db = context.turbine;
  const accessor = db.table(table);
  return {
    name: 'turbine-source', adapter: 'repository source with shared native handle/pool',
    page: () => accessor.findMany({ where: { id: { gt: 16, lte: 80 } }, orderBy: { id: 'asc' } }),
    point: (round) => accessor.findMany({ where: { id: round % 16 + 1 } }),
    transaction: (rollback = false) => db.$transaction(async (tx) => {
      for (const id of [1, 2]) await tx.table(table).update({ where: { id }, data: { value: { increment: 1 } } });
      const result = await tx.table(table).findMany({ orderBy: { id: 'asc' } });
      if (rollback) throw new Error('evidence rollback control');
      return result;
    }),
    ...(['sqlite', 'postgresql', 'mysql'].includes(context.engine) ? {
      native: async (_round, sample) => {
        const drain = async (source) => {
          const sink = digest();
          for await (const batch of source.findManyStreamBatches({ orderBy: { id: 'asc' }, batchSize: BATCH_SIZE })) {
            for (const row of batch) sink.row(row);
            sample();
          }
          return sink.finish();
        };
        return context.engine === 'mysql' ? db.$transaction((tx) => drain(tx.table(table))) : drain(accessor);
      },
      nativeContract: context.engine === 'sqlite'
        ? 'native SQLite iterator in batches; includes Turbine speculative LIMIT probe/transaction policy'
        : context.engine === 'mysql'
          ? 'mysql2 callback row events; batches 128; ordered digest; explicit Turbine transaction; includes speculative LIMIT129 reread'
          : 'native pg cursor in batches; includes Turbine speculative LIMIT probe/transaction policy',
    } : {}),
  };
}

export async function drizzleArm(context, alias) {
  const { engine, native } = context;
  const operators = await import(alias);
  let db;
  let definition;
  let adapter;
  if (engine === 'sqlite') {
    const core = await import(`${alias}/sqlite-core`);
    definition = core.sqliteTable(table, { id: core.integer('id').primaryKey(), label: core.text('label').notNull(), value: core.integer('value').notNull(), note: core.text('note') });
    if (alias === 'drizzle-stable') {
      adapter = 'sqlite-proxy over the same node:sqlite handle (async callback overhead included)';
      const { drizzle } = await import(`${alias}/sqlite-proxy`);
      db = drizzle(async (sql, params, method) => {
        const statement = native.prepare(sql);
        if (method === 'run') { statement.run(...params); return { rows: [] }; }
        // Stable proxy expects positional columns; column order comes from SQLite.
        if (method === 'get') { const row = statement.get(...params); return { rows: row ? Object.values(row) : [] }; }
        return { rows: statement.all(...params).map((row) => Object.values(row)) };
      });
    } else {
      adapter = 'node-sqlite over the same node:sqlite handle';
      const { drizzle } = await import(`${alias}/node-sqlite`);
      db = drizzle({ client: native });
    }
  } else if (engine === 'postgresql') {
    const core = await import(`${alias}/pg-core`);
    definition = core.pgTable(table, { id: core.integer('id').primaryKey(), label: core.text('label').notNull(), value: core.integer('value').notNull(), note: core.text('note') });
    const { drizzle } = await import(`${alias}/node-postgres`);
    db = drizzle({ client: native });
    adapter = 'node-postgres on the same max=1 pool';
  } else if (engine === 'mysql') {
    const core = await import(`${alias}/mysql-core`);
    definition = core.mysqlTable(table, { id: core.int('id').primaryKey(), label: core.varchar('label', { length: 200 }).notNull(), value: core.int('value').notNull(), note: core.varchar('note', { length: 200 }) });
    const { drizzle } = await import(`${alias}/mysql2`);
    // Stable's mode discriminator rejects this config shape. Its positional
    // signature and RC's config signature must both receive the actual pool.
    db = alias === 'drizzle-stable' ? drizzle(native, { mode: 'default' }) : drizzle({ client: native });
    adapter = 'mysql2 on the same max=1 pool';
  } else {
    const core = await import(`${alias}/mssql-core`);
    definition = core.mssqlTable(table, { id: core.int('id').primaryKey(), label: core.nvarchar('label', { length: 200 }).notNull(), value: core.int('value').notNull(), note: core.nvarchar('note', { length: 200 }) });
    const { drizzle } = await import(`${alias}/node-mssql`);
    db = drizzle({ client: native });
    adapter = 'node-mssql on the same max=1 pool';
  }
  const { and, asc, eq, gt, lte, sql } = operators;
  return {
    name: alias, adapter,
    page: () => db.select().from(definition).where(and(gt(definition.id, 16), lte(definition.id, 80))).orderBy(asc(definition.id)),
    point: (round) => db.select().from(definition).where(eq(definition.id, round % 16 + 1)),
    // RC node:sqlite callbacks are synchronous: run each statement synchronously
    // inside the callback, then let the harness await the completed transaction.
    ...(engine === 'sqlite' && alias === 'drizzle-candidate' ? {
      transaction: (rollback = false) => db.transaction((tx) => {
        for (const id of [1, 2]) tx.update(definition).set({ value: sql`${definition.value} + 1` }).where(eq(definition.id, id)).run();
        const result = tx.select().from(definition).orderBy(asc(definition.id)).all();
        if (rollback) throw new Error('evidence rollback control');
        return result;
      }),
    } : {
      transaction: (rollback = false) => db.transaction(async (tx) => {
        for (const id of [1, 2]) await tx.update(definition).set({ value: sql`${definition.value} + 1` }).where(eq(definition.id, id));
        const result = await tx.select().from(definition).orderBy(asc(definition.id));
        if (rollback) throw new Error('evidence rollback control');
        return result;
      }),
    }),
  };
}

/** Untimed route audit of the actual native callback. Instrumentation is removed
 * before warmup and measurement; no ORM implementation is modified. */
export async function auditNative(context, arm) {
  if (context.engine === 'mysql') return auditMysqlNative(context, arm);
  const statements = [];
  const commands = [];
  let iteratorOpens = 0;
  let steppedRows = 0;
  let restore;
  if (context.engine === 'sqlite') {
    const prepare = context.native.prepare;
    context.native.prepare = function (sql, ...rest) {
      statements.push(sql);
      const statement = prepare.call(this, sql, ...rest);
      const iterate = statement.iterate;
      statement.iterate = function (...args) {
        iteratorOpens++;
        const iterator = iterate.apply(this, args);
        const next = iterator.next;
        iterator.next = function (...values) {
          const result = next.apply(this, values);
          if (!result.done) steppedRows++;
          return result;
        };
        return iterator;
      };
      return statement;
    };
    restore = () => { context.native.prepare = prepare; };
  } else if (context.engine === 'postgresql') {
    const client = await context.native.connect();
    // Turbine can cache a bound client.query, so audit the pinned pg wire
    // connection instead. Both simple and extended protocol SQL are observed.
    const connection = client.connection;
    const query = connection.query;
    const parse = connection.parse;
    let current;
    const record = (sql) => { statements.push(sql); current = { sql, rows: 0, tags: [] }; commands.push(current); };
    const row = () => { if (current) current.rows++; };
    const complete = (message) => { if (current) current.tags.push(message.text); };
    connection.on('dataRow', row); connection.on('commandComplete', complete);
    connection.query = function (sql, ...args) {
      record(sql);
      return query.call(this, sql, ...args);
    };
    connection.parse = function (config, ...args) {
      record(config.text);
      return parse.call(this, config, ...args);
    };
    client.release();
    restore = () => { connection.query = query; connection.parse = parse; connection.off('dataRow', row); connection.off('commandComplete', complete); };
  } else throw new Error('No certified native route audit for this engine');
  let value;
  try { value = await arm.native(0, () => {}); }
  finally { restore(); }
  if (context.engine === 'sqlite' && (iteratorOpens !== 1 || steppedRows !== FIXTURE.length)) {
    throw new Error(`${arm.name}: native route did not step exactly one SQLite iterator over every row`);
  }
  const route = context.engine === 'postgresql' ? { driver: 'pg', statements, commands } : { statements, iteratorOpens, steppedRows };
  if (context.engine === 'postgresql') assertPgRoute(route);
  return { value, route };
}
