/** Shared assertions run against a real isolated D1 binding, in Worker ESM and Node ESM/CJS. */
import type { D1Migration, D1MigrationError, migrateD1 } from '../../../d1/migrate.js';
import type { D1DatabaseBinding, D1PreparedStatement } from '../../../d1/types.js';

type Migrate = typeof migrateD1;
const JOURNAL = '_turbine_d1_migrations';
function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}
function same(actual: unknown, expected: unknown, label: string) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${label}: ${JSON.stringify(actual)}`);
}
async function refusal(action: () => Promise<unknown>, phase?: string) {
  try {
    await action();
  } catch (error) {
    if (phase) {
      same((error as D1MigrationError).phase, phase, 'error phase');
      same((error as D1MigrationError).outcome, phase === 'dispatch' ? 'unknown' : 'not-dispatched', 'error outcome');
    }
    return error;
  }
  throw new Error('Expected refusal was accepted');
}
async function query(db: D1DatabaseBinding, sql: string) {
  return (await db.prepare(sql).all()).results;
}
async function reset(db: D1DatabaseBinding) {
  const objects = await query(
    db,
    "SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1 ELSE 2 END",
  );
  for (const row of objects) {
    if (row.type === 'table' || row.type === 'view' || row.type === 'trigger') {
      await query(db, `DROP ${String(row.type)} IF EXISTS "${String(row.name).replaceAll('"', '""')}"`);
    }
  }
}
function intercept(db: D1DatabaseBinding, batch: D1DatabaseBinding['batch']): D1DatabaseBinding {
  return { prepare: (sql) => db.prepare(sql), batch };
}
function pauseDispatch(db: D1DatabaseBinding) {
  let release!: () => void;
  let ready!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    ready = resolve;
  });
  return {
    reached,
    release,
    binding: intercept(db, async (statements) => {
      ready();
      await paused;
      return db.batch(statements);
    }),
  };
}

export async function runD1MigrationContract(db: D1DatabaseBinding, migrate: Migrate) {
  const groups: string[] = [];
  const run = async (name: string, action: () => Promise<void>) => {
    await reset(db);
    try {
      await action();
      groups.push(name);
    } catch (error) {
      throw new Error(`Native contract group: ${name}`, { cause: error });
    } finally {
      await reset(db);
    }
  };
  const basic: D1Migration[] = [
    {
      id: '0001_create',
      statements: [
        '\uFEFF -- native BOM\n /*before*/ CREATE TABLE "events"(id INTEGER PRIMARY KEY, value TEXT NOT NULL); --tail',
      ],
    },
    {
      id: '0002_seed',
      statements: [
        "INSERT INTO events VALUES (1, 'semi; -- /* literal */ and ''quote''')",
        'CREATE UNIQUE INDEX [event_value] ON `events`(value)',
      ],
    },
    {
      id: '0003_alter',
      statements: ['ALTER TABLE events ADD COLUMN "end" INTEGER DEFAULT 7', 'UPDATE events SET "end" = 8 WHERE id = 1'],
    },
  ];
  await run('ordered prefix, exact values, durable checksums, duplicate retry, ownership', async () => {
    same((await migrate(db, basic, { through: '0002_seed' })).applied, ['0001_create', '0002_seed'], 'prefix');
    const history = await query(db, `SELECT position,id,checksum FROM ${JOURNAL} WHERE position > 0 ORDER BY position`);
    check(
      history.length === 2 && history.every((row) => /^[a-f0-9]{64}$/.test(String(row.checksum))),
      'durable SHA256 history',
    );
    same((await migrate(db, basic)).applied, ['0003_alter'], 'remaining prefix');
    same((await migrate(db, basic)).applied, [], 'idempotent retry');
    same(
      await query(db, 'SELECT * FROM events'),
      [{ id: 1, value: "semi; -- /* literal */ and 'quote'", end: 8 }],
      'exact SQL effects and binding remains usable',
    );
    await refusal(() => migrate(db, basic, { through: '0001_create' }), 'admission');
  });
  await run('drift, missing, reordered, gapped and tampered history', async () => {
    await migrate(db, basic);
    await refusal(() => migrate(db, basic.slice(0, 2)), 'admission');
    await refusal(() => migrate(db, [basic[1]!, basic[0]!, basic[2]!]), 'admission');
    await refusal(
      () =>
        migrate(db, [basic[0]!, { ...basic[1]!, statements: ["INSERT INTO events VALUES (2, 'changed')"] }, basic[2]!]),
      'admission',
    );
    await query(db, `UPDATE ${JOURNAL} SET checksum = '${'0'.repeat(64)}' WHERE position = 3`);
    await refusal(() => migrate(db, basic), 'admission');
    await query(db, `DELETE FROM ${JOURNAL} WHERE position = 2`);
    await refusal(() => migrate(db, basic), 'admission');
    same((await query(db, 'SELECT count(*) AS n FROM events'))[0]?.n, 1, 'refusals preserve data');
  });
  await run('SQL failure rolls back all selected schema, data AND bootstrap history', async () => {
    const broken = [
      {
        id: '0001_broken',
        statements: [
          'CREATE TABLE rollback_test(id INTEGER PRIMARY KEY)',
          'INSERT INTO rollback_test VALUES (1)',
          'INSERT INTO rollback_test VALUES (1)',
        ],
      },
    ];
    await refusal(() => migrate(db, broken), 'dispatch');
    same(
      await query(db, "SELECT name FROM sqlite_schema WHERE name IN ('rollback_test', '_turbine_d1_migrations')"),
      [],
      'whole-batch and CREATE IF ABSENT rollback',
    );
    await migrate(db, basic, { through: '0001_create' });
    const later = [
      ...basic.slice(0, 1),
      { id: '0002_fail', statements: ['CREATE TABLE rollback_test(id INTEGER)', 'INSERT INTO absent VALUES (1)'] },
    ];
    await refusal(() => migrate(db, later), 'dispatch');
    same(await query(db, "SELECT name FROM sqlite_schema WHERE name = 'rollback_test'"), [], 'pending DDL rolled back');
    same(
      (await query(db, `SELECT count(*) AS n FROM ${JOURNAL} WHERE position > 0`))[0]?.n,
      1,
      'previous history retained',
    );
  });
  await run('concurrent first deployment: stale loser cannot execute user SQL', async () => {
    const a = pauseDispatch(db);
    const b = pauseDispatch(db);
    const plan = [
      { id: '0001_race', statements: ['CREATE TABLE counter(n INTEGER)', 'INSERT INTO counter VALUES (1)'] },
    ];
    const pa = migrate(a.binding, plan);
    const pb = migrate(b.binding, plan);
    const settled = Promise.allSettled([pa, pb]);
    await Promise.all([a.reached, b.reached]);
    a.release();
    b.release();
    const result = await settled;
    same(result.filter((entry) => entry.status === 'fulfilled').length, 1, 'one deployment commits');
    same(result.filter((entry) => entry.status === 'rejected').length, 1, 'stale deployment refused');
    same(await query(db, 'SELECT * FROM counter'), [{ n: 1 }], 'exactly one user effect');
    same((await migrate(db, plan)).applied, [], 'loser safe retry');
  });
  await run('stale existing history and changed checksum race', async () => {
    const initial = [
      { id: '0001_counter', statements: ['CREATE TABLE counter(n INTEGER)', 'INSERT INTO counter VALUES (0)'] },
    ];
    await migrate(db, initial);
    const a = pauseDispatch(db);
    const plan = [
      ...initial,
      { id: '0002_race', statements: ['UPDATE counter SET n=n+1', 'CREATE TABLE loser_schema(n INTEGER)'] },
    ];
    const pending = migrate(a.binding, plan);
    const failed = refusal(() => pending, 'dispatch');
    await a.reached;
    await migrate(db, [...initial, { id: '0002_other', statements: ['UPDATE counter SET n=n+10'] }]);
    a.release();
    await failed;
    same(await query(db, 'SELECT * FROM counter'), [{ n: 10 }], 'stale writer never executes');
    same(await query(db, "SELECT name FROM sqlite_schema WHERE name='loser_schema'"), [], 'no stale DDL');
    await refusal(() => migrate(db, plan), 'admission');
  });
  await run('schema race refuses and rolls back journal bootstrap', async () => {
    const held = pauseDispatch(db);
    const pending = migrate(held.binding, basic);
    const failed = refusal(() => pending, 'dispatch');
    await held.reached;
    await query(db, 'CREATE TABLE outsider(id INTEGER)');
    held.release();
    await failed;
    same(
      await query(db, "SELECT name FROM sqlite_schema WHERE name IN ('events','_turbine_d1_migrations')"),
      [],
      'guard fails before user SQL and undoes bootstrap',
    );
    same(
      await query(db, "SELECT name FROM sqlite_schema WHERE name='outsider'"),
      [{ name: 'outsider' }],
      'foreign change retained',
    );
  });
  await run('journal replacement race cannot bypass assertion by removing constraints', async () => {
    await migrate(db, basic, { through: '0001_create' });
    const held = pauseDispatch(db);
    const pending = migrate(held.binding, basic);
    const failed = refusal(() => pending, 'dispatch');
    await held.reached;
    const old = await query(db, `SELECT position,id,checksum FROM ${JOURNAL}`);
    await query(db, `DROP TABLE ${JOURNAL}`);
    await query(db, `CREATE TABLE ${JOURNAL}(position INTEGER,id TEXT,checksum TEXT)`);
    for (const row of old)
      await db.prepare(`INSERT INTO ${JOURNAL} VALUES (?1,?2,?3)`).bind(row.position, row.id, row.checksum).all();
    held.release();
    await failed;
    same(await query(db, 'SELECT * FROM events'), [], 'no migration effects with replaced constraints');
    same(await query(db, `SELECT * FROM ${JOURNAL}`), old, 'refusal cannot insert an impossible guard row');
  });
  await run('same-cardinality journal checksum race is checked in native batch', async () => {
    await migrate(db, basic, { through: '0001_create' });
    const held = pauseDispatch(db);
    const pending = migrate(held.binding, basic);
    const failed = refusal(() => pending, 'dispatch');
    await held.reached;
    await query(db, `UPDATE ${JOURNAL} SET checksum='${'0'.repeat(64)}'`);
    held.release();
    await failed;
    same(await query(db, 'SELECT * FROM events'), [], 'changed checksum never executes seed');
    same(
      (await query(db, `SELECT count(*) AS n FROM ${JOURNAL} WHERE position > 0`))[0]?.n,
      1,
      'no partial journal append',
    );
  });
  await run('trigger installed after pre-read cannot run through migration SQL', async () => {
    await migrate(db, basic, { through: '0001_create' });
    const held = pauseDispatch(db);
    const pending = migrate(held.binding, basic);
    const failed = refusal(() => pending, 'dispatch');
    await held.reached;
    await query(db, `CREATE TRIGGER hostile AFTER INSERT ON events BEGIN DELETE FROM ${JOURNAL}; END`);
    held.release();
    await failed;
    same(await query(db, 'SELECT * FROM events'), [], 'trigger race refuses before insert');
    same(
      (await query(db, `SELECT count(*) AS n FROM ${JOURNAL} WHERE position > 0`))[0]?.n,
      1,
      'trigger never erased history',
    );
  });
  await run('lost response AFTER native commit and malformed success reconcile on retry', async () => {
    let calls = 0;
    const lost = intercept(db, async (statements) => {
      calls++;
      await db.batch(statements);
      throw new Error('simulated response loss after actual commit');
    });
    await refusal(() => migrate(lost, basic), 'dispatch');
    same(calls, 1, 'no automatic retry');
    same((await query(db, 'SELECT count(*) AS n FROM events'))[0]?.n, 1, 'native commit actually happened');
    same((await migrate(db, basic)).applied, [], 'reconciles committed batch');
    const malformed = intercept(db, async (statements) => {
      await db.batch(statements);
      return [];
    });
    const extended = [...basic, { id: '0004_more', statements: ["INSERT INTO events(id,value) VALUES (2,'two')"] }];
    await refusal(() => migrate(malformed, extended), 'dispatch');
    same((await migrate(db, extended)).applied, [], 'malformed response retry');
    same((await query(db, 'SELECT count(*) AS n FROM events'))[0]?.n, 2, 'no duplicated effect');
  });
  await run('snapshot ALL caller inputs before WebCrypto and ignore post-dispatch abort', async () => {
    const held = pauseDispatch(db);
    const mutable = basic.map((item) => ({ id: item.id, statements: [...item.statements] }));
    const abort = new AbortController();
    const options = { through: '0002_seed', signal: abort.signal };
    const pending = migrate(held.binding, mutable, options);
    mutable[0]!.id = '9999_mutated';
    mutable[1]!.statements[0] = 'DELETE FROM events';
    mutable[2]!.statements[0] = 'COMMIT';
    mutable.length = 0;
    options.through = '0003_alter';
    options.signal = new AbortController().signal;
    await held.reached;
    abort.abort(new Error('too late to cancel'));
    held.release();
    same((await pending).applied, ['0001_create', '0002_seed'], 'captured selected prefix');
    same((await migrate(db, basic)).applied, ['0003_alter'], 'hashes capture complete original SQL');
  });
  await run('pre-dispatch abort and invalid later input cause zero native work', async () => {
    let calls = 0;
    const watched: D1DatabaseBinding = {
      prepare(sql) {
        calls++;
        return db.prepare(sql);
      },
      batch: (items) => db.batch(items),
    };
    const reason = new Error('pre-abort');
    const abort = new AbortController();
    abort.abort(reason);
    check((await refusal(() => migrate(watched, basic, { signal: abort.signal }))) === reason, 'exact abort reason');
    for (const invalid of [
      null,
      {},
      [undefined],
      [{ id: '0001_x', statements: [] }],
      [basic[0], basic[0]],
      [basic[0], { id: '0002_x', statements: ['COMMIT'] }],
      [{ id: '0001_x', statements: ['SELECT 1'] }],
    ]) {
      await refusal(() => migrate(watched, invalid as D1Migration[]), 'admission');
    }
    await refusal(() => migrate(watched, basic, { through: 'absent' }), 'admission');
    await refusal(() => migrate(watched, basic, { transaction: true } as never), 'admission');
    same(calls, 0, 'no preparation on invalid input');
    // Abort during the first crypto await: reads may happen, dispatch must not.
    let batches = 0;
    const pre = new AbortController();
    const promise = migrate(
      intercept(db, (items) => {
        batches++;
        return db.batch(items);
      }),
      basic,
      { signal: pre.signal },
    );
    pre.abort(reason);
    check((await refusal(() => promise)) === reason, 'abort before dispatch');
    same(batches, 0, 'zero dispatched batches');
  });
  await run('SQLite lexical/control/trigger/quoted journal negative controls', async () => {
    const invalid = [
      '\uFEFF -- control\n BEGIN IMMEDIATE',
      '/*x*/END TRANSACTION',
      'ROLLBACK',
      'SAVEPOINT x',
      'RELEASE x',
      'PRAGMA foreign_keys=OFF',
      "ATTACH DATABASE 'x' AS other",
      'VACUUM',
      'CREATE TEMP TABLE x(id)',
      'CREATE VIRTUAL TABLE x USING fts5(a)',
      'CREATE TRIGGER x AFTER INSERT ON events BEGIN DELETE FROM events; END',
      'CREATE TABLE x(id); COMMIT',
      'CREATE TABLE x(id); /*x*/ INSERT INTO x VALUES(1)',
      'CREATE TABLE "_turbine_d1_migrations"(id)',
      "CREATE TABLE '_TURBINE_D1_MIGRATIONS'(id)",
      'CREATE TABLE [_turbine_d1_migrations](id)',
      'CREATE TABLE `_turbine_d1_migrations`(id)',
      'UPDATE main . "_turbine_d1_migrations" SET checksum=\'x\'',
      'CREATE TABLE x(id REFERENCES "_turbine_d1_migrations"(position))',
      'CREATE TABLE x AS SELECT * FROM sqlite_schema',
      'INSERT INTO x VALUES(?1)',
      'CREATE TABLE x(id) /* unterminated',
      'CREATE TABLE "unterminated(id)',
      'CREATE TABLE x(id)\x00',
    ];
    for (const sql of invalid)
      await refusal(() => migrate(db, [{ id: '0001_refusal', statements: [sql] }]), 'admission');
    same(
      await query(db, "SELECT name FROM sqlite_schema WHERE name='_turbine_d1_migrations'"),
      [],
      'lexical refusals never bootstrap',
    );
  });
  await run('existing trigger, journal schema collision, view and checksum constraint tampering', async () => {
    await query(db, 'CREATE TABLE external(id INTEGER)');
    await query(db, 'CREATE TRIGGER external_trigger AFTER INSERT ON external BEGIN UPDATE external SET id=id+1; END');
    await refusal(() => migrate(db, basic), 'admission');
    await query(db, 'DROP TRIGGER external_trigger');
    await query(db, `CREATE TABLE ${JOURNAL}(position INTEGER, id TEXT, checksum TEXT)`);
    await refusal(() => migrate(db, basic), 'admission');
    await query(db, `DROP TABLE ${JOURNAL}`);
    await query(db, `CREATE VIEW ${JOURNAL} AS SELECT 1 AS position, 'x' AS id, 'x' AS checksum`);
    await refusal(() => migrate(db, basic), 'admission');
    await query(db, `DROP VIEW ${JOURNAL}`);
    await migrate(db, basic);
    await query(db, `CREATE INDEX extra_journal_index ON ${JOURNAL}(checksum)`);
    await refusal(() => migrate(db, basic), 'admission');
  });
  await run('native proof control: unguarded stale batch REALLY duplicates effects', async () => {
    await query(db, 'CREATE TABLE unsafe_counter(n INTEGER)');
    await query(db, 'INSERT INTO unsafe_counter VALUES(0)');
    const statements = () => [db.prepare('UPDATE unsafe_counter SET n=n+1')];
    await Promise.all([db.batch(statements()), db.batch(statements())]);
    same(await query(db, 'SELECT * FROM unsafe_counter'), [{ n: 2 }], 'negative control detects missing guard');
  });
  await run('native SQLite quoted-name behavior, commented virtual table and SQL-token normalization', async () => {
    for (const quoted of [`'${JOURNAL}'`, `"${JOURNAL.toUpperCase()}"`, `[${JOURNAL}]`, `\`${JOURNAL}\``]) {
      await query(db, `CREATE TABLE ${quoted}(id INTEGER)`);
      await refusal(() => migrate(db, basic), 'admission');
      await query(db, `DROP TABLE ${quoted}`);
    }
    await query(db, 'CREATE /*native comment*/ VIRTUAL TABLE search_test USING fts5(content)');
    await refusal(() => migrate(db, basic), 'admission');
    await query(db, 'DROP TABLE search_test');
    // The server proves why lexical admission cannot simply pass raw trivia.
    await refusal(() => query(db, '\uFEFF --native\n CREATE TABLE trivia_test(id INTEGER); -- comment-only tail'));
    await migrate(db, [
      {
        id: '0001_trivia',
        statements: ['\uFEFF --native\n CREATE TABLE trivia_test(id INTEGER); -- comment-only tail'],
      },
    ]);
    same(
      await query(db, "SELECT name FROM sqlite_schema WHERE name='trivia_test'"),
      [{ name: 'trivia_test' }],
      'admitted normalization works on the actual native parser',
    );
  });
  await run('journal head detects deleted suffix, erased history and missing head', async () => {
    await migrate(db, basic);
    await query(db, `DELETE FROM ${JOURNAL} WHERE position=3`);
    await refusal(() => migrate(db, basic), 'admission');
    await query(db, `DELETE FROM ${JOURNAL} WHERE position>0`);
    await refusal(() => migrate(db, basic), 'admission');
    await query(db, `DELETE FROM ${JOURNAL}`);
    await refusal(() => migrate(db, basic), 'admission');
    same(
      (await query(db, 'SELECT count(*) AS n FROM events'))[0]?.n,
      1,
      'history tampering cannot duplicate user effects',
    );
  });
  await run('read/preparation failures do not dispatch and malformed native success remains unknown', async () => {
    const cause = new Error('injected boundary failure');
    const readFailure: D1DatabaseBinding = {
      prepare() {
        throw cause;
      },
      batch: (statements) => db.batch(statements),
    };
    const readError = await refusal(() => migrate(readFailure, basic), 'read');
    check((readError as Error).cause === cause, 'read failure preserves cause');
    const prepareFailure: D1DatabaseBinding = {
      prepare(sql) {
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) throw cause;
        return db.prepare(sql);
      },
      batch: (statements) => db.batch(statements),
    };
    const prepareError = await refusal(() => migrate(prepareFailure, basic), 'admission');
    check((prepareError as Error).cause === cause, 'preparation failure preserves cause');
    same(
      await query(db, `SELECT name FROM sqlite_schema WHERE name='${JOURNAL}'`),
      [],
      'preparation failure never bootstraps',
    );
    const malformed = intercept(db, async <Row>(statements: D1PreparedStatement[]) => {
      const results = await db.batch<Row>(statements);
      results[0]!.success = false;
      return results;
    });
    await refusal(() => migrate(malformed, basic), 'dispatch');
    same((await migrate(db, basic)).applied, [], 'native commit with malformed individual result reconciles');
  });
  return { ok: true, groups, count: groups.length };
}
