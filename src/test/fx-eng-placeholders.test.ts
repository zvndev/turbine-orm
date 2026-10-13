/**
 * Placeholders on the engines that bind by name (SQLite, MySQL, SQL Server).
 *
 * - `rawUnsafe(text, ...values)` documents `$1..$n` for every engine. The
 *   shims rewrite each `$n` that the ENGINE reads as code (never one inside a
 *   string literal, a quoted identifier or a comment) to their own spelling,
 *   and refuse a `$n` with no value and a bare `?` with E003.
 * - An `in` / `notIn` list is one builder param, so the SQL text stays
 *   independent of the list's length. Each engine then binds the elements so a
 *   list element compares exactly as the same value given to `equals` does:
 *   MySQL expands the placeholder into one per element (padded to a power of
 *   two), SQLite and SQL Server encode the elements into the JSON their
 *   `json_each` / `OPENJSON` list reads.
 *
 * Build-only and fake-driver tests; the live comparisons are in
 * fx-eng-in-list.integration.test.ts and the cross-engine battery.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { MssqlPool, mssqlDialect } from '../mssql.js';
import { MysqlPool, mysqlDialect } from '../mysql.js';
import { rewritePositionalPlaceholders, scanPlaceholders } from '../sql-placeholders.js';
import { sqliteDialect } from '../sqlite.js';

const refuse = (message: string): never => {
  throw new ValidationError(message);
};
const pg = (sql: string, syntax: 'mysql' | 'sqlite' | 'mssql', count: number, prefix = ':p') =>
  rewritePositionalPlaceholders(sql, syntax, count, (i) => `${prefix}${i}`, refuse);

describe('scanPlaceholders: only what the engine reads as code', () => {
  const positional = (sql: string, syntax: 'mysql' | 'sqlite' | 'mssql') =>
    scanPlaceholders(sql, syntax)
      .filter((t) => t.kind === 'positional')
      .map((t) => sql.slice(t.start, t.end));

  it('finds a $n in code on every engine', () => {
    for (const syntax of ['mysql', 'sqlite', 'mssql'] as const) {
      assert.deepEqual(positional('SELECT $1, $2 FROM t WHERE a = $10', syntax), ['$1', '$2', '$10'], syntax);
    }
  });

  it('skips string literals, with doubled-quote escapes', () => {
    for (const syntax of ['mysql', 'sqlite', 'mssql'] as const) {
      assert.deepEqual(positional("SELECT 'a $1 b', 'it''s $2', $3", syntax), ['$3'], syntax);
    }
  });

  it('skips quoted identifiers in each engine own quoting', () => {
    assert.deepEqual(positional('SELECT `a$1`, `$2`, $3', 'mysql'), ['$3']);
    assert.deepEqual(positional('SELECT "$1", `$2`, [$3], $4', 'sqlite'), ['$4']);
    assert.deepEqual(positional('SELECT "$1", [a $2]]x $3], $4', 'mssql'), ['$4']);
  });

  it('skips comments in each engine own syntax', () => {
    assert.deepEqual(positional('SELECT $1 # $2\n, $3 -- $4\n, /* $5 */ $6', 'mysql'), ['$1', '$3', '$6']);
    // MySQL needs whitespace after `--`; `5--$1` is arithmetic, so $1 is code.
    assert.deepEqual(positional('SELECT 5--$1', 'mysql'), ['$1']);
    assert.deepEqual(positional('SELECT $1 --$2\n, /* $3 */ $4', 'sqlite'), ['$1', '$4']);
    // SQL Server nests block comments, SQLite does not.
    assert.deepEqual(positional('SELECT /* a /* $1 */ $2 */ $3', 'mssql'), ['$3']);
    assert.deepEqual(positional('SELECT /* a /* $1 */ $2', 'sqlite'), ['$2']);
  });

  it('treats a backslash as an escape inside a MySQL string, so a placeholder is never invented in one', () => {
    assert.deepEqual(positional("SELECT 'it\\'s $1', $2", 'mysql'), ['$2']);
    // SQLite has no backslash escapes: the string ends at the second quote.
    assert.deepEqual(positional("SELECT 'a\\', $1", 'sqlite'), ['$1']);
  });

  it('a $ inside a word, or digits running into one, is not a placeholder', () => {
    assert.deepEqual(positional('SELECT price$1, $1abc, x.$2', 'mysql'), ['$2']);
    assert.deepEqual(positional('SELECT @p$1, #t$2, $3', 'mssql'), ['$3']);
  });

  it('reports MySQL named placeholders the way mysql2 reads them', () => {
    const named = scanPlaceholders('SELECT :p1, :p10, `:p2`, ":p3", a:=1', 'mysql')
      .filter((t) => t.kind === 'named')
      .map((t) => t.name);
    assert.deepEqual(named, ['p1', 'p10']);
  });
});

describe('rewritePositionalPlaceholders', () => {
  it('rewrites to the engine spelling, repeats included', () => {
    assert.equal(pg('SELECT $1, $2, $1', 'sqlite', 2), 'SELECT :p1, :p2, :p1');
    assert.equal(pg('SELECT $1', 'mssql', 1, '@p'), 'SELECT @p1');
  });

  it('returns the same string when there is nothing to rewrite', () => {
    const sql = "SELECT '$1' FROM t WHERE a = :p1";
    assert.equal(pg(sql, 'mysql', 1), sql);
  });

  it('leaves a statement given no values alone (on MySQL `$1` can be an identifier)', () => {
    assert.equal(pg('SELECT $1 FROM t', 'mysql', 0), 'SELECT $1 FROM t');
  });

  it('refuses a $n past the values given, and $0', () => {
    assert.throws(() => pg('SELECT $3', 'mysql', 2), /\$3 names no value: the statement was given 2 values/);
    assert.throws(() => pg('SELECT $0', 'sqlite', 1), /\$0 names no value/);
  });

  it('refuses a bare ? and names the spelling that works', () => {
    assert.throws(
      () => pg('SELECT ?', 'sqlite', 1),
      /A `\?` placeholder cannot be bound here: write the values as \$1/,
    );
    assert.equal(pg("SELECT '?', $1", 'mysql', 1), "SELECT '?', :p1");
  });
});

/** A mysql2-shaped pool that records what reaches the driver. */
function recordingMysql() {
  const calls: { kind: 'execute' | 'query'; sql: string; binding: unknown }[] = [];
  const run =
    (kind: 'execute' | 'query') =>
    async (sql: string, binding?: unknown): Promise<[unknown, unknown]> => {
      calls.push({ kind, sql, binding });
      return [[], []];
    };
  const raw = {
    execute: run('execute'),
    query: run('query'),
    getConnection: async () => ({ execute: run('execute'), query: run('query'), release() {} }),
    end: async () => {},
  };
  return { pool: new MysqlPool(raw as never), calls };
}

describe('MySQL: an in list binds one placeholder per element', () => {
  const list = (values: unknown[]) => mysqlDialect.inClauseParam?.(values);
  const text = (negated = false) => mysqlDialect.buildInClause?.('`a`', ':p2', negated) ?? '';

  it('the builder text is length-independent', () => {
    assert.equal(text(), '`a` IN (:p2)');
    assert.equal(text(true), '`a` NOT IN (:p2)');
  });

  it('expands to the next power of two, repeating the last element, each bound as equality binds it', async () => {
    const { pool, calls } = recordingMysql();
    const at = new Date('2026-01-02T03:04:05.006Z');
    await pool.query(`SELECT * FROM t WHERE b = :p1 AND ${text()}`, [7, list([true, 9007199254740993n, at])]);
    assert.equal(calls[0]?.kind, 'execute');
    assert.equal(calls[0]?.sql, 'SELECT * FROM t WHERE b = :p1 AND `a` IN (:p2_0, :p2_1, :p2_2, :p2_2)');
    assert.deepEqual(calls[0]?.binding, { p1: 7, p2_0: 1, p2_1: 9007199254740993n, p2_2: at });
  });

  it('a one-element list is not padded, and a power of two is not padded further', async () => {
    const { pool, calls } = recordingMysql();
    await pool.query(`SELECT 1 FROM t WHERE ${text()}`, [7, list(['x'])]);
    await pool.query(`SELECT 1 FROM t WHERE ${text()}`, [7, list(['a', 'b', 'c', 'd'])]);
    assert.equal(calls[0]?.sql, 'SELECT 1 FROM t WHERE `a` IN (:p2_0)');
    assert.equal(calls[1]?.sql, 'SELECT 1 FROM t WHERE `a` IN (:p2_0, :p2_1, :p2_2, :p2_3)');
  });

  it('an empty list is a subquery with no rows: IN is false, NOT IN is true', async () => {
    const { pool, calls } = recordingMysql();
    await pool.query(`SELECT 1 FROM t WHERE ${text(true)}`, [7, list([])]);
    assert.equal(calls[0]?.sql, 'SELECT 1 FROM t WHERE `a` NOT IN (SELECT NULL FROM DUAL WHERE FALSE)');
  });

  it('a list too long for one statement is refused before it is sent', async () => {
    const { pool, calls } = recordingMysql();
    await assert.rejects(
      pool.query(`SELECT 1 FROM t WHERE b = :p1 AND ${text()}`, [7, list(Array.from({ length: 65_535 }, (_, i) => i))]),
      (err) =>
        err instanceof ValidationError &&
        /binds one placeholder per element, and this statement needs 65536 where MySQL allows 65535/.test(err.message),
    );
    assert.equal(calls.length, 0);
  });

  it('near the limit the padding is dropped rather than the statement refused', async () => {
    const { pool, calls } = recordingMysql();
    await pool.query(`SELECT 1 FROM t WHERE ${text()}`, [7, list(Array.from({ length: 40_000 }, (_, i) => i))]);
    const placeholders = (calls[0]?.sql.match(/:p2_/g) ?? []).length;
    assert.equal(placeholders, 40_000);
  });

  it('rawUnsafe-style $n is rewritten to :pN on the same path', async () => {
    const { pool, calls } = recordingMysql();
    await pool.query("SELECT $1 AS a, '$2' AS b, `$2` AS c", ['v']);
    assert.equal(calls[0]?.sql, "SELECT :p1 AS a, '$2' AS b, `$2` AS c");
    assert.deepEqual(calls[0]?.binding, { p1: 'v' });
  });

  it('a statement with no values still runs through query()', async () => {
    const { pool, calls } = recordingMysql();
    await pool.query('START TRANSACTION');
    assert.deepEqual(calls[0], { kind: 'query', sql: 'START TRANSACTION', binding: undefined });
  });
});

describe('SQLite: an in list element is written as equality would bind it', () => {
  const json = (values: unknown[]) => sqliteDialect.inClauseParam?.(values) as string;

  it('bigints exactly, binary as a hex object, infinities, booleans and dates', () => {
    assert.equal(
      json([9007199254740993n, Buffer.from([0, 255]), Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, true, false]),
      '[9007199254740993,{"b":"00ff"},9e999,-9e999,1,0]',
    );
    assert.equal(
      json([new Date('2026-01-02T03:04:05.006Z'), null, 'x"y']),
      '["2026-01-02T03:04:05.006Z",null,"x\\"y"]',
    );
  });

  it('the list decodes a binary element back to a BLOB', () => {
    const sql = sqliteDialect.buildInClause?.('"a"', ':p1', false) ?? '';
    assert.match(
      sql,
      /^"a" IN \(SELECT CASE WHEN type = 'object' THEN unhex\(json_extract\(value, '\$\.b'\)\) ELSE value END FROM json_each\(:p1\)\)$/,
    );
  });
});

describe('SQL Server: an in list element is the text that converts to the bound value', () => {
  const json = (values: unknown[]) => mssqlDialect.inClauseParam?.(values) as string;

  it('a bigint as its digits and a Date as UTC with no zone', () => {
    assert.equal(json([9007199254740993n, 2n]), '[9007199254740993,2]');
    assert.equal(
      json([new Date('2026-01-15T12:00:00.000Z'), 'a', true, null]),
      '["2026-01-15T12:00:00.000","a",true,null]',
    );
  });

  it('a binary element is refused with E017 naming the spelling that works', () => {
    assert.throws(
      () => json([Buffer.from([1])]),
      (err) => err instanceof UnsupportedFeatureError && /Write the list as branches/.test(err.message),
    );
  });

  it('rawUnsafe-style $n becomes @pN, never a MONEY literal', async () => {
    const sent: string[] = [];
    const request = {
      input: () => request,
      query: async (text: string) => {
        sent.push(text);
        return { recordset: [], rowsAffected: [0] };
      },
      batch: async () => ({ recordset: [], rowsAffected: [0] }),
    };
    const raw = { request: () => request, connect: async () => raw, close: async () => {} };
    const pool = new MssqlPool(raw as never, { ISOLATION_LEVEL: {} } as never);
    await pool.query("SELECT $1 AS a, '$1' AS b, [$1] AS c", ['v']);
    assert.deepEqual(sent, ["SELECT @p1 AS a, '$1' AS b, [$1] AS c"]);
    await assert.rejects(pool.query('SELECT $2', ['v']), /\$2 names no value/);
  });
});
