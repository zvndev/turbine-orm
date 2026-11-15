/** Exact contracts shared only by the original PostgreSQL secondary suites. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { drizzle } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleRc } from 'drizzle-rc/node-postgres';
import { makeJitRqbMapper } from 'drizzle-rc/relations';
import pg from 'pg';
import { TurbineClient } from '../generated/turbine/index.js';
import { type Arm, Bench, type ScenarioResult } from './bench-harness.js';
import { observedPgIdentity } from './pg-admission.js';
import { assertExact, canonical, type Row } from './equivalence.js';
import * as schema from './schema.js';
import * as rcSchema from './schema-rc.js';

import {
  assertRoute,
  type Command,
  type Role,
  type RouteKind,
  SECONDARY_SEMANTICS,
  type Trace,
} from './secondary-admission.js';

export type { Command, Role, RouteKind, Trace, Wire } from './secondary-admission.js';
export {
  assertRoute,
  BATCH,
  DEEP_SCENARIO,
  LATENCY_SCENARIOS,
  SECONDARY_SEMANTICS,
  STREAM_SCENARIO,
} from './secondary-admission.js';

const aliases = { created_at: 'createdAt', updated_at: 'updatedAt', last_login_at: 'lastLoginAt' } as const;
const dates = new Set(['createdAt', 'updatedAt', 'lastLoginAt']);

/** Timestamp decoding differs for JSON and scalar columns; no text/integer coercion beyond declared fields. */
export function values(value: unknown, field?: string): unknown {
  if (value === null) return null;
  if (field && dates.has(field) && typeof value === 'string') {
    assert.match(value, /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/);
    const date = new Date(value);
    assert.ok(Number.isFinite(date.getTime()), 'Invalid timestamp');
    return date;
  }
  if (Array.isArray(value)) return value.map((v) => values(v));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, values(v, aliases[k as keyof typeof aliases] ?? k)]),
    );
  }
  return value;
}

export function exact(label: string, actual: unknown, expected: unknown): void {
  assertExact(label, values(actual), values(expected));
}
export function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(values(value))))
    .digest('hex');
}

export interface Receipt {
  count: number;
  sha256: string;
}
export function consumer(observe?: (row: unknown) => void) {
  const hash = createHash('sha256');
  let count = 0;
  return {
    row(row: unknown) {
      observe?.(row);
      // Length-framed JSON covers every field and the sequence, without retaining the drained table.
      const json = JSON.stringify(canonical(values(row)));
      hash.update(`${Buffer.byteLength(json)}:`).update(json);
      count++;
    },
    done(): Receipt {
      return { count, sha256: hash.digest('hex') };
    },
  };
}

export function integer(name: string, fallback: number, min = 1): number {
  const n = Number(process.env[name] ?? fallback);
  assert.ok(Number.isSafeInteger(n) && n >= min, `${name} must be an integer >= ${min}`);
  return n;
}
export function isMain(url: string): boolean {
  return !!process.argv[1] && pathToFileURL(process.argv[1]).href === url;
}

/** Hooks are inert outside untimed verification. Names are checked against actual Parse/Bind, not comments. */
export class Observer {
  active?: Trace;
  readonly pids = new Set<number>();
  private disabled = false;
  private readonly restores: (() => void)[] = [];
  disable(): void {
    assert.equal(this.active, undefined, 'Cannot disable active observation');
    this.disabled = true;
    for (const restore of this.restores.reverse()) restore();
    this.restores.length = 0;
  }
  attach(pool: pg.Pool, role: Role): void {
    pool.on('connect', (client) => {
      this.pids.add((client as unknown as { processID: number }).processID);
      if (this.disabled) return;
      // pg exposes protocol methods without public TypeScript declarations.
      const connection = (client as unknown as { connection: Record<string, (...a: any[]) => any> }).connection;
      // Native pipeline temporarily swaps listeners. Observe emit itself so its completions cannot disappear.
      const emit = connection.emit!;
      this.restores.push(() => {
        connection.emit = emit;
      });
      connection.emit = (event: string, ...args: any[]) => {
        if (event === 'commandComplete')
          this.active?.completions.push({
            role,
            pid: (client as unknown as { processID: number }).processID,
            tag: args[0].text,
          });
        return emit.call(connection, event, ...args);
      };
      for (const method of ['parse', 'bind', 'query', 'execute', 'sync']) {
        const send = connection[method]!;
        this.restores.push(() => {
          connection[method] = send;
        });
        connection[method] = (...args: any[]) => {
          const arg = args[0];
          this.active?.wire.push({
            role,
            pid: (client as unknown as { processID: number }).processID,
            method,
            name: method === 'bind' ? (arg.statement ?? '') : method === 'parse' ? (arg.name ?? '') : '',
            ...(method === 'parse' ? { sql: arg.text } : method === 'query' ? { sql: arg } : {}),
          });
          return send.apply(connection, args);
        };
      }
      const originalQuery = client.query;
      this.restores.push(() => {
        client.query = originalQuery;
      });
      const query = client.query.bind(client) as (...a: any[]) => any;
      client.query = ((...args: any[]) => {
        const capture = this.active;
        if (!capture) return query(...args);
        const config = args[0];
        const command: Command = {
          role,
          pid: (client as unknown as { processID: number }).processID,
          sql: typeof config === 'string' ? config : config.text,
          name: typeof config === 'object' ? (config.name ?? '') : '',
          values:
            typeof config === 'object' && config.values !== undefined
              ? config.values
              : Array.isArray(args[1])
                ? args[1]
                : [],
        };
        assert.equal(typeof command.sql, 'string', 'Unobserved pg Query route');
        capture.commands.push(command);
        const finish = (error: Error | null, result?: pg.QueryResult | pg.QueryResult[]) => {
          if (error) command.error = error.message;
          else {
            const results = Array.isArray(result) ? result : [result!];
            command.rows = results.reduce((n, r) => n + r.rows.length, 0);
            command.tags = results.map((r) => r.command);
          }
        };
        const last = args.length - 1;
        if (typeof args[last] === 'function') {
          const callback = args[last];
          args[last] = (error: Error | null, result: pg.QueryResult) => {
            finish(error, result);
            callback(error, result);
          };
          return query(...args);
        }
        return query(...args).then(
          (result: pg.QueryResult) => {
            finish(null, result);
            return result;
          },
          (error: Error) => {
            finish(error);
            throw error;
          },
        );
      }) as typeof client.query;
    });
  }
  async capture<T>(fn: () => Promise<T>): Promise<{ value: T; trace: Trace }> {
    assert.equal(this.disabled, false, 'Observation already disabled for timing');
    assert.equal(this.active, undefined, 'Nested route observation');
    const trace: Trace = { commands: [], wire: [], completions: [] };
    this.active = trace;
    try {
      return { value: await fn(), trace };
    } finally {
      this.active = undefined;
    }
  }
}

export interface Fixture {
  users: Row[];
  posts: Row[];
  comments: Row[];
  fingerprint: string;
  counts: Record<string, number>;
}
export async function fixture(pool: pg.Pool): Promise<Fixture> {
  const counts = (
    await pool.query(`SELECT (SELECT count(*)::int FROM organizations) organizations,
    (SELECT count(*)::int FROM users) users, (SELECT count(*)::int FROM posts) posts,
    (SELECT count(*)::int FROM comments) comments, (SELECT count(*)::int FROM tags) tags,
    (SELECT count(*)::int FROM post_tags) post_tags, (SELECT count(*)::int FROM bench_wide) bench_wide`)
  ).rows[0];
  assert.deepEqual(
    counts,
    { organizations: 5, users: 1000, posts: 10000, comments: 50000, tags: 50, post_tags: 30000, bench_wide: 2000 },
    'Original fixture scale required',
  );
  // Snapshot flat native rows. JS derives filters, pages, nested values and dashboard counts independently of ORM queries.
  const users = (await pool.query('SELECT * FROM users ORDER BY id ASC')).rows;
  const posts = (await pool.query('SELECT * FROM posts ORDER BY id ASC')).rows;
  const comments = (await pool.query('SELECT * FROM comments ORDER BY id ASC')).rows;
  assert.ok(
    users.some((r) => r.avatar_url === null) && users.some((r) => r.last_login_at === null),
    'Null fixture sentinels missing',
  );
  assert.ok(
    new Set(posts.map((r) => (r.created_at as Date).getTime())).size < posts.length,
    'Timestamp tie sentinels missing',
  );
  return { users, posts, comments, counts, fingerprint: digest({ users, posts, comments }) };
}
export function newest(a: Row, b: Row): number {
  return (b.created_at as Date).getTime() - (a.created_at as Date).getTime() || Number(b.id) - Number(a.id);
}
export function expectedDashboard(f: Fixture): unknown[] {
  return [
    f.users.find((r) => String(r.id) === '1'),
    f.posts.filter((r) => String(r.user_id) === '1').length,
    f.comments.filter((r) => String(r.user_id) === '1').length,
    f.posts
      .filter((r) => String(r.user_id) === '1')
      .sort(newest)
      .slice(0, 5),
    f.users.length,
  ];
}

function fileSha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function treeSha(root: string): string {
  const paths: string[] = [];
  const walk = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else paths.push(path);
    }
  };
  walk(root);
  return digest(paths.map((path) => [path.slice(root.length + 1), fileSha(path)]));
}
export function profile() {
  const require = createRequire(import.meta.url);
  const versions = Object.fromEntries(
    ['pg', 'drizzle-orm', 'drizzle-rc', '@prisma/client', '@prisma/adapter-pg', 'prisma'].map((name) => {
      // Drizzle does not export package.json.
      const path = new URL(`./node_modules/${name}/package.json`, import.meta.url);
      return [name, JSON.parse(readFileSync(path, 'utf8')).version];
    }),
  );
  assert.deepEqual(
    versions,
    {
      pg: '8.23.1',
      'drizzle-orm': '0.45.4',
      'drizzle-rc': '1.0.0-rc.5',
      '@prisma/client': '7.10.1',
      '@prisma/adapter-pg': '7.10.1',
      prisma: '7.10.1',
    },
    'Installed comparison profile mismatch',
  );
  const root = fileURLToPath(new URL('..', import.meta.url));
  const rootRequire = createRequire(join(root, 'package.json'));
  const installedPackage = process.env.PG_BENCH_INSTALLED_PACKAGE;
  const provenance = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
    path: root,
    localDistSha256: installedPackage ? null : treeSha(join(root, 'dist')),
    installedDistSha256: installedPackage ? treeSha(join(installedPackage, 'dist')) : null,
    sourceSha256: installedPackage ? null : treeSha(join(root, 'src')),
    generatedSha256: treeSha(join(root, 'generated/turbine')),
    rootLockSha256: installedPackage ? null : fileSha(join(root, 'package-lock.json')),
    benchmarkLockSha256: fileSha(join(root, 'benchmarks/package-lock.json')),
    rootPg: rootRequire('pg/package.json').version,
    rootPgPath: rootRequire.resolve('pg'),
    benchmarkPgPath: require.resolve('pg'),
    artifact: process.env['SECONDARY_TURBINE_ARTIFACT']
      ? {
          path: resolve(process.env['SECONDARY_TURBINE_ARTIFACT']),
          sha256: fileSha(resolve(process.env['SECONDARY_TURBINE_ARTIFACT'])),
        }
      : null,
  };
  return {
    versions,
    provenance,
    poolMax: 10,
    driver: require.resolve('pg'),
    preparedPolicy:
      'Explicit preparedStatements=true preserves original owned-pool policy; forceCustomPlan arm is unnamed',
    mode: 'supplied-pg8.23.1; preparedStatements explicitly true (supplied-pool default is false)',
    node: process.version,
    source:
      process.env.PG_BENCH_ARTIFACT_SCOPE ??
      'generated Turbine client imports local turbine-orm dist; does not certify an installed consumer artifact',
  };
}

export function resources(url: string) {
  const observer = new Observer();
  const pools = Object.fromEntries(
    (['turbine', 'prisma', 'stable', 'rc', 'raw'] as const).map((role) => {
      const pool = new pg.Pool({
        connectionString: url,
        max: 10,
        connectionTimeoutMillis: 5000,
        query_timeout: 15000,
        application_name: `secondary:${role}`,
      });
      observer.attach(pool, role);
      return [role, pool];
    }),
  ) as Record<Role, pg.Pool>;
  const turbine = new TurbineClient({ pool: pools.turbine, logging: false, preparedStatements: true });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pools.prisma) });
  const stable = drizzle(pools.stable, { schema });
  const rc = drizzleRc({ client: pools.rc, relations: rcSchema.relations, jit: true });
  return {
    pools,
    observer,
    turbine,
    prisma,
    stable,
    rc,
    async connect() {
      assert.equal(
        (turbine as unknown as { pool: unknown }).pool,
        pools.turbine,
        'Turbine did not retain the matched supplied pg pool',
      );
      await turbine.connect();
      assert.ok(
        turbine.users.buildFindUnique({ where: { id: 1 } }).preparedName,
        'Explicitly prepared supplied-pool descriptor is unnamed',
      );
      const mapper = (rc as unknown as { dialect: { mapperGenerators: { relationalRows: unknown } } }).dialect
        .mapperGenerators.relationalRows;
      assert.equal(mapper, makeJitRqbMapper, 'RC JIT mapper was not selected by this client');
      const compiled = makeJitRqbMapper({
        selection: [{ key: 'id', field: rcSchema.users.id, fieldType: 'Column' }],
        isFirst: false,
        parseJson: false,
        parseJsonIfString: false,
        rootJsonMappers: false,
        arrayModeRoot: false,
      });
      assert.ok(
        (compiled as typeof compiled & { body?: string }).body?.includes('jitRqbMapper'),
        'RC JIT did not compile',
      );
    },
    async close() {
      const settled = await Promise.allSettled([turbine.disconnect(), prisma.$disconnect()]);
      const ended = await Promise.allSettled(Object.values(pools).map((pool) => pool.end()));
      const errors = [...settled, ...ended].filter((r) => r.status === 'rejected');
      assert.equal(errors.length, 0, `Client/pool cleanup failed: ${JSON.stringify(errors)}`);
      for (const pool of Object.values(pools)) assert.equal(pool.totalCount, 0, 'Borrowed pg pool still owns clients');
    },
  };
}
export type Resources = ReturnType<typeof resources>;
export interface SecondaryArm extends Arm {
  role: Role;
  route: RouteKind;
  strategy: string;
  preparedName?: string;
}
export interface Scenario {
  scenario: string;
  arms: SecondaryArm[];
  expected: unknown;
  stream?: Row[];
  note: string;
}
export interface RunOptions {
  verifyOnly?: boolean;
  mutate?: (scenarios: Scenario[]) => void;
  reportPath?: string;
}
export interface Verification {
  role: Role;
  preparedName?: string;
  scenario: string;
  arm: string;
  strategy: string;
  route: RouteKind;
  valueSha256: string;
  trace: Trace;
}
export interface Report {
  secondarySemantics: string;
  suite: string;
  status: 'running' | 'passed' | 'failed';
  timing: boolean;
  profile: ReturnType<typeof profile>;
  fixture?: { fingerprint: string; counts: Record<string, number> };
  verified: Verification[];
  results: ScenarioResult[];
  cleanup: { closed: boolean; sessionPids: number[] };
  error?: string;
  cleanupError?: string;
  [key: string]: unknown;
}

export async function verify(r: Resources, scenarios: Scenario[], report: Report): Promise<void> {
  assert.ok(scenarios.length, 'Empty secondary catalog');
  for (const scenario of scenarios) {
    assert.ok(scenario.arms.length >= 5, 'Missing original ORM/native arms');
    for (const arm of scenario.arms) {
      let position = 0;
      const observed = (row: unknown) => {
        assert.ok(scenario.stream && position < scenario.stream.length, 'Stream emitted extra values');
        exact(`${scenario.scenario}/${arm.name}/row ${position}`, row, scenario.stream[position]);
        position++;
      };
      const { value, trace } = await r.observer.capture(() => arm.fn(0, scenario.stream ? observed : undefined));
      exact(`${scenario.scenario}/${arm.name}`, value, scenario.expected);
      if (scenario.stream) assert.equal(position, scenario.stream.length, 'Stream omitted complete row values');
      assertRoute(trace, arm.role, arm.route);
      if (arm.preparedName !== undefined) {
        assert.ok(arm.preparedName, 'Prepared descriptor name is empty');
        assert.equal(trace.commands[0]!.name, arm.preparedName, 'Observed pg name differs from built descriptor');
      }
      report.verified.push({
        scenario: scenario.scenario,
        arm: arm.name,
        role: arm.role,
        ...(arm.preparedName !== undefined ? { preparedName: arm.preparedName } : {}),
        strategy: arm.strategy,
        route: arm.route,
        valueSha256: digest(value),
        trace,
      });
      console.log(
        `[exact preflight] ${scenario.scenario} / ${arm.name}: values, order and ${arm.route} route verified`,
      );
    }
  }
}

/** Single owner for client cleanup and failure reports, including errors before the first scenario. */
export async function execute(
  suite: string,
  url: string,
  options: RunOptions,
  run: (r: Resources, report: Report, verifyOnly: boolean) => Promise<void>,
): Promise<Report> {
  const report: Report = {
    secondarySemantics: SECONDARY_SEMANTICS,
    provenance: observedPgIdentity(),
    runtime: observedPgIdentity()?.runtime ?? { node: process.version, executable: process.execPath },
    suite,
    status: 'running',
    timing: !options.verifyOnly,
    profile: profile(),
    verified: [],
    results: [],
    cleanup: { closed: false, sessionPids: [] },
  };
  let r: Resources | undefined;
  let failure: unknown;
  try {
    r = resources(url);
    await r.connect();
    await run(r, report, !!options.verifyOnly);
    report.status = 'passed';
  } catch (error) {
    failure = error;
    report.status = 'failed';
    report.error = String(error);
  } finally {
    if (r) {
      report.cleanup.sessionPids = [...r.observer.pids];
      try {
        await r.close();
        report.cleanup.closed = true;
      } catch (error) {
        report.status = 'failed';
        report.cleanupError = String(error);
        failure ??= error;
      }
    }
    if (options.reportPath) writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failure) throw failure;
  return report;
}

export async function measure(scenarios: Scenario[], report: Report, rounds: number, warmup: number): Promise<void> {
  const bench = new Bench({ rounds, warmup });
  for (const s of scenarios) await bench.interleave(s.scenario, s.arms, { note: s.note });
  report.results = bench.results;
}
export function output(report: Report): void {
  console.log('\n=== JSON ===');
  console.log(JSON.stringify(report, null, 2));
  console.log('\nDone.');
}
