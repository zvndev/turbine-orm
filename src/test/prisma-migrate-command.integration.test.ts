/**
 * turbine-orm - `turbine migrate-from-prisma` end-to-end.
 *
 * Runs the REAL CLI (via Node's tsx import hook) in a temp cwd:
 *   - `--no-db` parse-only always runs (no database needed).
 *   - the resolved run is gated on DATABASE_URL; it loads the shop.sql fixture
 *     into the target database's public schema, drives the command, asserts the
 *     report + generated prisma-map.ts, then drops the fixture tables.
 *
 * The fixture DDL (shop.sql) matches shop.prisma. Fixture table names are
 * distinct (shop_users, products, orders, order_items, tags, _ProductToTag) so
 * they never collide with the shared correctness seed.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/prisma-migrate-command.integration.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { skipGate } from './helpers.js';

const repoRoot = process.cwd();
const tsxLoader = pathToFileURL(resolve(repoRoot, 'node_modules/tsx/dist/loader.mjs')).href;
const cliEntry = resolve(repoRoot, 'src/cli/index.ts');
const haveTsx = existsSync(resolve(repoRoot, 'node_modules/tsx'));
const shopPrisma = resolve(repoRoot, 'src/test/fixtures/prisma/shop.prisma');
const shopSql = resolve(repoRoot, 'src/test/fixtures/prisma/shop.sql');

/** Run the CLI in `cwd`; return { code, output } without throwing on failure. */
function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): { code: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', tsxLoader, cliEntry, 'migrate-from-prisma', ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', ...env },
    });
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { code: e.status ?? 1, output: `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}` };
  }
}

// ---------------------------------------------------------------------------
// Parse-only (no database) - always runs when tsx is present.
// ---------------------------------------------------------------------------

describe('turbine migrate-from-prisma - parse-only (--no-db)', () => {
  it('writes a report but no prisma-map.ts and exits 0', { skip: !haveTsx }, () => {
    const dir = join(tmpdir(), `turbine-mfp-nodb-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const { code, output } = runCli(dir, ['--schema', shopPrisma, '--out', './out', '--no-db', '--no-timestamp'], {
        DATABASE_URL: '',
      });
      assert.equal(code, 0, `expected exit 0; output:\n${output}`);
      const report = join(dir, 'out', 'prisma-migration-report.md');
      assert.ok(existsSync(report), 'report written');
      assert.ok(!existsSync(join(dir, 'out', 'prisma-map.ts')), 'no map in --no-db mode');
      const md = readFileSync(report, 'utf-8');
      assert.match(md, /parse-only/);
      assert.match(md, /\| User \|/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Resolved against a live database.
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const gate = skipGate(!url || !haveTsx, 'no DATABASE_URL (or tsx) - skipping DB-backed migrate-from-prisma');
const FIXTURE_TABLES = ['"_ProductToTag"', 'order_items', 'orders', 'products', 'tags', 'shop_users'];

describe('turbine migrate-from-prisma - resolved against DB', () => {
  let pool: pg.Pool | undefined;

  gate.before(async () => {
    pool = new pg.Pool({ connectionString: url });
    await pool.query(readFileSync(shopSql, 'utf-8'));
  });

  gate.after(async () => {
    if (pool) {
      for (const t of FIXTURE_TABLES) await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
      await pool.query('DROP TYPE IF EXISTS shop_role CASCADE');
      await pool.end();
    }
  });

  gate.it('resolves the whole schema, exits 0, and writes report + typed map', () => {
    const dir = join(tmpdir(), `turbine-mfp-db-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const { code, output } = runCli(dir, ['--schema', shopPrisma, '--url', url!, '--out', './out', '--no-timestamp']);
      assert.equal(code, 0, `expected exit 0 (all resolved); output:\n${output}`);

      const mapPath = join(dir, 'out', 'prisma-map.ts');
      const reportPath = join(dir, 'out', 'prisma-migration-report.md');
      assert.ok(existsSync(mapPath), 'prisma-map.ts written');
      assert.ok(existsSync(reportPath), 'report written');

      const map = readFileSync(mapPath, 'utf-8');
      assert.match(map, /export const PRISMA_MAP: PrismaCompatMap =/);
      // @@map divergence + accessor
      assert.match(map, /User: \{\s*\n\s*table: 'shop_users',\s*\n\s*accessor: 'shopUsers'/);
      // field @map
      assert.match(map, /displayName: 'displayName'/);
      // disambiguated relations to the same model
      assert.match(map, /buyer: \{ name: 'buyer', cardinality: 'one' \}/);
      assert.match(map, /reviewer: \{ name: 'reviewer', cardinality: 'one' \}/);
      // implicit m2m
      assert.match(map, /tags: \{ name: 'tags', cardinality: 'many' \}/);
      // named + default compound uniques
      assert.match(map, /owner_sku: \['ownerId', 'sku'\]/);
      assert.match(map, /buyerId_productId: \['buyerId', 'productId'\]/);
      // enum via @@map
      assert.match(map, /enums: \{ Role: 'shop_role' \}/);

      const report = readFileSync(reportPath, 'utf-8');
      assert.match(report, /all items resolved/);
      assert.match(report, /Junction tables/);
      assert.match(report, /_ProductToTag/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
