import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SqlitePool, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!native, 'requires node:sqlite (Node >= 22.5)');
const streamAvailable = (() => {
  if (!native) return false;
  const probe = new native.DatabaseSync(':memory:');
  try {
    return typeof probe.isTransaction === 'boolean';
  } finally {
    probe.close();
  }
})();
const { it: streamIt } = skipGate(
  !streamAvailable,
  'requires native node:sqlite stream state (Node 22.x >= 22.16, or Node >= 24)',
);

it('refuses every unconsumed statement before prefix writes on cold, repeated and public raw routes', async () => {
  const db = new native!.DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(n INTEGER); INSERT INTO t VALUES(0)');
  const pool = new SqlitePool(db);
  const client = turbineSqlite(db, { tables: {}, enums: {} }, { logger: {} });
  try {
    for (const suffix of [
      ' UPDATE t SET n=n+100',
      ' /* tail */ UPDATE t SET n=n+100',
      " SELECT ';'",
      '\u0000UPDATE t SET n=100',
    ]) {
      const sql = `UPDATE t SET n=n+$1;${suffix}`;
      for (let i = 0; i < 2; i++) await assert.rejects(pool.query(sql, [1]), /accepts one statement/);
      await assert.rejects(client.rawUnsafe(sql, 1), /accepts one statement/);
      assert.equal(db.prepare('SELECT n FROM t').get()!.n, 0);
    }
    await assert.rejects(pool.query('UPDATE t SET n=1; UPDATE t SET n=2'), /accepts one statement/);
    assert.equal(db.prepare('SELECT n FROM t').get()!.n, 0);
    assert.deepEqual((await pool.query('SELECT n FROM t')).rows, [{ n: 0 }]);
  } finally {
    await client.disconnect();
    await pool.end();
  }
});

it('uses native statement boundaries for trigger bodies, quotes and trailing comments', async () => {
  const db = new native!.DatabaseSync(':memory:');
  const pool = new SqlitePool(db);
  try {
    await pool.query('CREATE TABLE t(n INTEGER)');
    await pool.query('CREATE TABLE audit(n INTEGER)');
    await pool.query(
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO audit VALUES(new.n); INSERT INTO audit VALUES(new.n+1); END; -- done\n;; /* trailing */',
    );
    await pool.query(' ; /* lead */ INSERT INTO t VALUES(7); /* trailing unclosed');
    assert.deepEqual((await pool.query('SELECT n FROM audit ORDER BY n; -- tail')).rows, [{ n: 7 }, { n: 8 }]);
    for (const sql of [
      "SELECT 'one;two' AS value",
      'SELECT 1 AS "semi;colon"',
      'SELECT 1 AS [semi;colon]',
      'SELECT 1 AS `semi;colon`',
    ])
      assert.equal((await pool.query(sql)).rowCount, 1);
  } finally {
    await pool.end();
  }
});

streamIt('refuses a second statement before stepping the native stream and releases ownership', async () => {
  const db = new native!.DatabaseSync(':memory:');
  const pool = new SqlitePool(db);
  let steps = 0;
  db.function('observed', () => ++steps);
  const connection = await pool.connect();
  try {
    const iterator = connection.streamBatches!('SELECT observed() AS value; SELECT 2', [], 10);
    await assert.rejects(iterator.next(), /accepts one statement/);
    assert.equal(steps, 0);
    assert.deepEqual((await connection.query('SELECT 1 AS value')).rows, [{ value: 1 }]);
  } finally {
    connection.release();
    await pool.end();
  }
});

it('refuses trailing SQL before a PRAGMA can change state during native prepare', async () => {
  const db = new native!.DatabaseSync(':memory:');
  const pool = new SqlitePool(db);
  const cache = () => db.prepare('PRAGMA cache_size').get()!.cache_size;
  const before = cache();
  try {
    for (const text of [
      'PRAGMA cache_size=123; SELECT 1',
      'EXPLAIN PRAGMA cache_size=123; SELECT 1',
      'EXPLAIN QUERY PLAN PRAGMA cache_size=123; SELECT 1',
      ' /* lead */ ; PRAGMA "cache_size"=123; "quoted"',
      'PRAGMA cache_size=123\u0000SELECT 1',
      'PRAGMA cache_size=123; -- end\nSELECT 1',
    ]) {
      await assert.rejects(pool.query(text), /accepts one statement/);
      assert.equal(cache(), before);
    }
    await pool.query("PRAGMA cache_size='123'; /* trailing */ ; -- done");
    assert.equal(cache(), 123);
  } finally {
    await pool.end();
  }
});

// The PRAGMA separator screen as it was first written, kept as the oracle for
// which statements it refuses. It retried from every `[` and every `;`, which
// is quadratic on a long run of either; the screen now scans once.
function screenOracle(sql: string): boolean {
  if (sql.includes('\0')) return true;
  if (!sql.includes(';')) return false;
  const code = sql
    .replace(
      /('(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\])|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g,
      (_text, q) => (q ? 'x' : ' '),
    )
    .replace(/^[;\s]+/, '');
  return /^(?:EXPLAIN\s+(?:QUERY\s+PLAN\s+)?)?PRAGMA\b/i.test(code) && /;[;\s]*[^;\s]/.test(code);
}

function screenCorpus(): string[] {
  const corpus = [
    'PRAGMA cache_size=1',
    'PRAGMA cache_size=1;',
    'PRAGMA cache_size=1; ;\n ;',
    'PRAGMA cache_size=1; x',
    'pragma cache_size=1 ; x',
    'EXPLAIN QUERY PLAN PRAGMA x; y',
    'EXPLAIN  PRAGMA x;y',
    'SELECT 1; PRAGMA x',
    '; ;PRAGMA x; y',
    "PRAGMA x='a;b'",
    "PRAGMA x='a'';b'; ",
    'PRAGMA x="a;b"; ',
    'PRAGMA x=`a;b`; z',
    'PRAGMA x=[a;b]; ',
    'PRAGMA x=[a;b; z',
    'PRAGMA x; [',
    'PRAGMA x; [ ]',
    'PRAGMA x; ]',
    'PRAGMA x; [a] [b',
    'PRAGMA x [a; [b] ;',
    'PRAGMA x; -- c',
    'PRAGMA x; -- c\ny',
    'PRAGMA x; /* c */',
    'PRAGMA x; /* c',
    'PRAGMA x; /* c */ y',
    '/* a */ PRAGMA x; /*',
    '-- a\nPRAGMA x;;',
    "PRAGMA x; 'unclosed",
    'PRAGMA x; "unclosed',
    'PRAGMA x; `unclosed',
    "PRAGMA x '[' ; ']'",
    'PRAGMA x; /* [ */ ]',
    'PRAGMA x; [ /* ] */ y',
    'PRAGMA\tx;\t',
    'PRAGMAx; y',
  ];
  // Seeded, so a failure names an input that reproduces.
  let seed = 0x5eed;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const heads = ['', ' ', ';', '; ', '/* h */', '-- h\n', "'q' ", '[q] '];
  const verbs = ['PRAGMA x', 'pragma x', 'EXPLAIN PRAGMA x', 'EXPLAIN QUERY PLAN PRAGMA x', 'SELECT 1', 'PRAGMAx'];
  const pieces = ["'", '"', '`', '[', ']', '--', '/*', '*/', '*', '/', '-', ';', ';', ';', ' ', '\n', '\t', 'y', 'x'];
  for (let i = 0; i < 3000; i++) {
    let sql = heads[next() % heads.length]! + verbs[next() % verbs.length]!;
    for (let n = next() % 16; n > 0; n--) sql += pieces[next() % pieces.length]!;
    corpus.push(sql);
  }
  return corpus;
}

it('the PRAGMA separator screen refuses exactly what it always refused', async () => {
  const db = new native!.DatabaseSync(':memory:');
  const pool = new SqlitePool(db);
  try {
    await pool.query('SELECT 1 AS warm');
    // Every statement the screen lets through reaches prepare, which then
    // stops it, so the screen's verdict is observed without running anything.
    const prepared: string[] = [];
    (db as unknown as { prepare: (sql: string) => never }).prepare = (sql) => {
      prepared.push(sql);
      throw new Error('stopped at prepare');
    };
    const corpus = screenCorpus();
    let refusals = 0;
    for (const sql of corpus) {
      const error = await pool.query(sql).then(
        () => undefined,
        (err: unknown) => err as Error,
      );
      const screened = !prepared.includes(sql);
      if (screened) assert.match(String(error?.message), /accepts one statement/, JSON.stringify(sql));
      assert.equal(screened, screenOracle(sql), `screen verdict differs for ${JSON.stringify(sql)}`);
      if (screened) refusals++;
      prepared.length = 0;
    }
    // Both verdicts occur often enough for the comparison to mean something.
    assert.ok(refusals > 300 && corpus.length - refusals > 300, `refused ${refusals} of ${corpus.length}`);
  } finally {
    await pool.end();
  }
});

it('screens long runs of brackets, separators, quotes and comments in linear time', async () => {
  const db = new native!.DatabaseSync(':memory:');
  const pool = new SqlitePool(db);
  const n = 100_000;
  const slow: string[] = [];
  try {
    for (const [sql, refused] of [
      [`PRAGMA cache_size=1; ${'['.repeat(n)}`, true],
      [`PRAGMA cache_size=1${';'.repeat(n)}`, false],
      [`PRAGMA cache_size=1${'; '.repeat(n)}`, false],
      [`PRAGMA cache_size=1; ${'/*'.repeat(n)}`, true],
      [`PRAGMA cache_size=1; ${"'".repeat(n)}`, true],
      [`PRAGMA cache_size=1; ${'--'.repeat(n)}`, false],
    ] as const) {
      const started = performance.now();
      const outcome = await pool.query(sql).then(
        () => 'ran',
        (err: unknown) => (/accepts one statement/.test(String((err as Error).message)) ? 'refused' : String(err)),
      );
      const elapsed = performance.now() - started;
      assert.equal(outcome, refused ? 'refused' : 'ran', sql.slice(0, 30));
      if (elapsed >= 1000) slow.push(`${JSON.stringify(sql.slice(0, 30))} took ${elapsed.toFixed(0)} ms`);
    }
    assert.deepEqual(slow, []);
  } finally {
    await pool.end();
  }
});
