/**
 * `turbine seed` honours the configured schema, and the URL rewrite behind it.
 *
 * The seed connects through `DATABASE_URL` in all three of its forms (a tsx
 * child, an in-process `import()`, a raw `.sql` file), so the configured schema
 * is applied ONCE, to that URL, as the `options=-c search_path` connection
 * parameter. `withSearchPathOption` (connection-url.ts, import-free) does the
 * rewrite; `connectionStringForSchema` (cli/migrate.ts) adds the "default is
 * unpinned" rule and the E003 wrapping. The unit half runs everywhere; the live
 * half needs DATABASE_URL and creates/drops schema `qa78_ns`.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/seed-schema.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { assertSchemaExists, connectionStringForSchema, type MigrationQueryClient } from '../cli/migrate.js';
import { TurbineClient } from '../client.js';
import { isPlainSchemaIdentifier, parseSearchPathValue, withSearchPathOption } from '../connection-url.js';
import { MigrationError } from '../errors.js';
import { skipGate } from './helpers.js';

const options = (url: string | null): string | null =>
  url === null ? null : new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('options');

/**
 * The helper's non-null result. It returns `null` rather than throwing (it is a
 * zero-import leaf and cannot raise a typed error), so a refusal must fail the
 * assertion it was standing in for rather than surface as a null dereference.
 */
const pin = (url: string, schema: string): string => {
  const out = withSearchPathOption(url, schema);
  assert.ok(out !== null, `expected ${schema} to be pinned on ${url}`);
  return out;
};

describe('withSearchPathOption: the URL rewrite', () => {
  it('a bare URL gains ?options=-c search_path="<schema>", quoted so case is preserved', () => {
    const out = pin('postgres://u:p@h/db', 'qa78_ns');
    assert.equal(out.slice(0, out.indexOf('?')), 'postgres://u:p@h/db');
    assert.equal(options(out), '-c search_path="qa78_ns"');
    assert.equal(options(withSearchPathOption('postgres://u:p@h/db', 'MySchema')), '-c search_path="MySchema"');
  });

  it('an existing query string keeps its other parameters', () => {
    const out = pin('postgres://u:p@h/db?sslmode=require', 'qa78_ns');
    const params = new URLSearchParams(out.slice(out.indexOf('?') + 1));
    assert.equal(params.get('sslmode'), 'require');
    assert.equal(params.get('options'), '-c search_path="qa78_ns"');
  });

  it('an existing ?options= is appended to, never replaced (the same merge statement_timeout uses)', () => {
    const out = pin('postgres://u:p@h/db?options=-c%20statement_timeout%3D5000', 'qa78_ns');
    assert.equal(options(out), '-c statement_timeout=5000 -c search_path="qa78_ns"');
  });

  it('folds PGOPTIONS in when it CREATES the parameter, because pg stops reading the env var once a URL carries one', () => {
    const saved = process.env.PGOPTIONS;
    process.env.PGOPTIONS = '-c statement_timeout=9000';
    try {
      assert.equal(
        options(withSearchPathOption('postgres://u:p@h/db', 'qa78_ns')),
        '-c statement_timeout=9000 -c search_path="qa78_ns"',
      );
    } finally {
      if (saved === undefined) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = saved;
    }
  });

  it('never mangles the userinfo: a percent-encoded password survives the rewrite byte-for-byte', () => {
    const out = pin('postgres://u:p%40ss%3Aw%3Frd@h:5432/db', 'qa78_ns');
    assert.ok(out.startsWith('postgres://u:p%40ss%3Aw%3Frd@h:5432/db?'));
  });

  it('returns null, never a guess, for anything that is not a plain identifier: the parameter is a literal and a space is a second -c', () => {
    for (const bad of ['qa78 ns', 'x; -c is_superuser=on', '1abc', 'a"b', '', 'a-b', 'a.b', 'sch\\ema', 'a\nb']) {
      assert.equal(withSearchPathOption('postgres://u:p@h/db', bad), null, JSON.stringify(bad));
      assert.equal(isPlainSchemaIdentifier(bad), false, JSON.stringify(bad));
    }
    for (const ok of ['public', 'qa78_ns', '_x', 'A$b', 'MySchema'])
      assert.equal(isPlainSchemaIdentifier(ok), true, ok);
  });

  it('returns null for a non-URL connection string rather than returning it unchanged (unchanged means the wrong schema)', () => {
    assert.equal(withSearchPathOption('host=h dbname=db', 'qa78_ns'), null);
  });
});

describe('parseSearchPathValue: reading the path a connection already has', () => {
  it('splits on commas outside quotes and un-doubles an escaped quote', () => {
    assert.deepEqual(parseSearchPathValue('"$user", public'), ['$user', 'public']);
    assert.deepEqual(parseSearchPathValue('app,public'), ['app', 'public']);
    assert.deepEqual(parseSearchPathValue('a, "b, c", d'), ['a', 'b, c', 'd']);
    assert.deepEqual(parseSearchPathValue('"we""ird", x'), ['we"ird', 'x']);
  });

  it('yields nothing for an empty path, which `SHOW` can render as an empty identifier', () => {
    assert.deepEqual(parseSearchPathValue(''), []);
    assert.deepEqual(parseSearchPathValue('""'), []);
    assert.deepEqual(parseSearchPathValue('"", public'), ['public']);
  });
});

describe('connectionStringForSchema: only "not configured" is unpinned', () => {
  it('undefined and the empty string return the input by reference', () => {
    const url = 'postgres://u:p@h/db';
    assert.equal(connectionStringForSchema(url, undefined), url);
    assert.equal(connectionStringForSchema(url, ''), url);
  });

  it('every configured schema is pinned, `public` included', () => {
    // `public` used to be exempted here on the reasoning that it is the default
    // anyway. It is not: `search_path` is a role/database/connection-string
    // setting, so on a role whose path is `app, public` a project configured
    // `schema: 'public'` had `push` creating in public (its pin is
    // unconditional) and `migrate up` creating in app. Two authorities on one
    // question; the answer is `push`'s, so `public` is pinned like any other.
    assert.equal(options(connectionStringForSchema('postgres://u:p@h/db', 'qa78_ns')), '-c search_path="qa78_ns"');
    assert.equal(options(connectionStringForSchema('postgres://u:p@h/db', 'public')), '-c search_path="public"');
  });

  it("the pin EXTENDS the connection's own path rather than replacing it", () => {
    // The other half of the same rule. Pinning the target ALONE means an
    // extension type installed in its own schema (`citext`, `vector`,
    // `postgis`) stops resolving, so a migration that ran fine unpinned fails
    // under the pin with `type "..." does not exist`. The target still comes
    // FIRST, which is what decides where an unqualified CREATE lands.
    assert.equal(
      options(connectionStringForSchema('postgres://u:p@h/db', 'app', ['public', 'extensions'])),
      '-c search_path="app","public","extensions"',
    );
    // The target is not repeated when the inherited path already names it.
    assert.equal(
      options(connectionStringForSchema('postgres://u:p@h/db', 'public', ['public', 'extensions'])),
      '-c search_path="public","extensions"',
    );
  });

  it('drops an inherited name it cannot emit safely, rather than escaping it', () => {
    // The emitted value is a LITERAL inside `options=-c`, which libpq splits on
    // whitespace, so a name carrying a space could carry a second `-c` and set
    // any GUC it liked. Inherited names come from the server, but the alphabet
    // is what makes the literal safe and it is not relaxed for them. Dropping
    // is monotone: before this parameter existed, ALL of them were dropped.
    for (const hostile of ['x -c log_statement=all', 'a"b', "a'b", 'a b', 'a\\b', '-c', 'a,b', '1abc', 'a\nb', '']) {
      assert.equal(
        options(connectionStringForSchema('postgres://u:p@h/db', 'app', [hostile])),
        '-c search_path="app"',
        JSON.stringify(hostile),
      );
    }
    // `$user` is the one name outside the pattern that is still emitted: it is
    // Postgres's own token, leads the default path nearly everywhere, and
    // carries no whitespace, quote or backslash.
    assert.equal(
      options(connectionStringForSchema('postgres://u:p@h/db', 'app', ['$user', 'public'])),
      '-c search_path="app","$user","public"',
    );
  });

  it('a hostile TARGET is still refused outright (the validator did not move)', () => {
    for (const bad of ['x -c log_statement=all', 'a"b', 'a b', '1abc', 'pg;drop']) {
      assert.throws(
        () => connectionStringForSchema('postgres://u:p@h/db', bad, ['public']),
        /TURBINE_E003/,
        JSON.stringify(bad),
      );
    }
  });

  it('a name or a string the leaf refuses surfaces as ValidationError E003, with the reason', () => {
    assert.throws(
      () => connectionStringForSchema('postgres://u:p@h/db', 'qa78 ns'),
      /TURBINE_E003[\s\S]*plain identifier/,
    );
    assert.throws(() => connectionStringForSchema('host=h dbname=db', 'qa78_ns'), /TURBINE_E003[\s\S]*not a URL/);
  });
});

// ---------------------------------------------------------------------------
// Live: the rewritten URL actually resolves there, through the real client and
// through the real `turbine seed` command.
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const repoRoot = process.cwd();
const tsxLoader = pathToFileURL(resolve(repoRoot, 'node_modules/tsx/dist/loader.mjs')).href;
const cliEntry = resolve(repoRoot, 'src/cli/index.ts');
const haveTsx = existsSync(resolve(repoRoot, 'node_modules/tsx'));
const gate = skipGate(
  !url || !haveTsx,
  !url ? 'DATABASE_URL not set' : 'tsx is not installed in node_modules (run npm ci)',
);

/** Run `turbine seed` in `cwd`; never throws, so a failing exit is asserted rather than thrown. */
function runSeedCli(cwd: string, args: string[]): { code: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', tsxLoader, cliEntry, 'seed', ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', DATABASE_URL: '' },
    });
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { code: e.status ?? 1, output: `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}` };
  }
}

/** Every table a seed in this suite creates, so cleanup and the clean start agree. */
const SEED_TABLES = ['qa78_seeded', 'qa78_seeded_missing'];

describe('seed runs in the configured schema (integration)', () => {
  let admin: pg.Client;
  let dir: string;

  const tableSchemas = async (table: string): Promise<string[]> => {
    const r = await admin.query<{ table_schema: string }>(
      `SELECT table_schema FROM information_schema.tables WHERE table_name = $1 ORDER BY table_schema`,
      [table],
    );
    return r.rows.map((row) => row.table_schema);
  };

  gate.before(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS qa78_ns CASCADE');
    await admin.query('CREATE SCHEMA qa78_ns');
    // Start clean in the role's default schema too: the failure mode under test
    // is precisely a table landing there.
    for (const t of SEED_TABLES) await admin.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    dir = mkdtempSync(join(tmpdir(), 'turbine-qa78-seed-'));
  });

  gate.after(async () => {
    await admin.query('DROP SCHEMA IF EXISTS qa78_ns CASCADE');
    for (const t of SEED_TABLES) await admin.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  });

  gate.it(
    'a TurbineClient on the rewritten URL sees current_schema() = qa78_ns (what defineSeed hands the callback)',
    async () => {
      const db = new TurbineClient(
        { connectionString: connectionStringForSchema(url!, 'qa78_ns') },
        { tables: {}, enums: {} },
      );
      try {
        const row = await db.sql<{ s: string }>`SELECT current_schema() AS s`.one();
        assert.equal(row?.s, 'qa78_ns');
      } finally {
        await db.disconnect();
      }
    },
  );

  gate.it('`turbine seed --schema qa78_ns` with a seed.sql creates its table in qa78_ns, not in public', async () => {
    writeFileSync(
      join(dir, 'seed.sql'),
      'CREATE TABLE qa78_seeded (id INTEGER PRIMARY KEY);\nINSERT INTO qa78_seeded VALUES (1);\n',
    );
    const { code, output } = runSeedCli(dir, ['--url', url!, '--schema', 'qa78_ns']);
    assert.equal(code, 0, output);
    assert.deepEqual(await tableSchemas('qa78_seeded'), ['qa78_ns'], output);
    const count = await admin.query<{ n: string }>('SELECT count(*)::text AS n FROM qa78_ns.qa78_seeded');
    assert.equal(count.rows[0]?.n, '1');
  });

  gate.it('a schema that does not exist fails the command instead of seeding somewhere else', async () => {
    writeFileSync(join(dir, 'seed.sql'), 'CREATE TABLE qa78_seeded_missing (id INTEGER PRIMARY KEY);\n');
    const { code } = runSeedCli(dir, ['--url', url!, '--schema', 'qa78_missing_ns']);
    assert.notEqual(code, 0);
    assert.deepEqual(await tableSchemas('qa78_seeded_missing'), []);
  });
});

/**
 * `assertSchemaExists` on its own, with a fake client and no database.
 *
 * The live half above proves the CLI refuses; this proves the refusal is asked
 * of the CATALOG rather than of the connection's resolved `current_schema()`,
 * which is the property that lets a pinned migration client and an unpinned
 * seed probe get the same answer. A fake is the only way to see the SQL and the
 * bound parameter, and the whole rule is in those two.
 */
interface Asked {
  sql: string;
  params: unknown[];
}

describe('assertSchemaExists asks the catalog, and its refusal names the schema', () => {
  /** Records what it was asked, and answers with whatever `rows` the test gives. */
  const fakeClient = (rows: Record<string, unknown>[]): MigrationQueryClient & { asked: Asked[] } => {
    const asked: Asked[] = [];
    return {
      asked,
      query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        asked.push({ sql, params: params ?? [] });
        return { rows: rows as R[], rowCount: rows.length, command: 'SELECT', fields: [] };
      },
    };
  };

  it('a present schema returns, having asked to_regnamespace with the name BOUND', async () => {
    const client = fakeClient([{ present: true }]);
    await assertSchemaExists(client, 'app');
    assert.equal(client.asked.length, 1);
    assert.match(client.asked[0]!.sql, /to_regnamespace\(\$1\)/);
    assert.deepEqual(client.asked[0]!.params, ['app']);
    // Not current_schema(): that answers for the CONNECTION, so a pinned client
    // and an unpinned one would disagree about the same database.
    assert.doesNotMatch(client.asked[0]!.sql, /current_schema/);
  });

  it('a missing schema throws E006 naming the schema, the CREATE and the config key', async () => {
    const client = fakeClient([{ present: false }]);
    await assert.rejects(
      () => assertSchemaExists(client, 'no_such_ns'),
      (err: unknown) => {
        assert.ok(err instanceof MigrationError, `expected MigrationError, got ${String(err)}`);
        assert.equal(err.code, 'TURBINE_E006');
        assert.match(err.message, /"no_such_ns"/);
        assert.match(err.message, /CREATE SCHEMA "no_such_ns"/);
        assert.match(err.message, /turbine\.config\.ts/);
        return true;
      },
    );
  });

  it('an unreadable answer is a refusal, not a pass', async () => {
    // `rows[0]` absent, or `present` anything but exactly true. A helper that
    // treated an unparseable answer as "yes" would be a guard that fails OPEN
    // on the one input it cannot interpret.
    for (const rows of [[], [{}], [{ present: null }], [{ present: 'true' }]] as Record<string, unknown>[][]) {
      await assert.rejects(() => assertSchemaExists(fakeClient(rows), 'app'), MigrationError, JSON.stringify(rows));
    }
  });
});
