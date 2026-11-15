/**
 * docs/engine-support.json is the engine and version support matrix, and
 * docs/engine-support.md plus site/lib/engine-support.generated.ts are rendered
 * from it by scripts/gen-engine-support.ts. These tests hold the data to the
 * repository: every package export has a route, every cited CI job exists and
 * runs the cited files under a requirement guard, every version CI is said to
 * exercise is pinned in that job, and both rendered files are current.
 *
 * Each guard is also run against a deliberately broken copy, so a validator
 * that stopped checking would fail here instead of passing everything.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * The generator lives in scripts/, outside this project's rootDir, so a literal
 * specifier fails `npm run typecheck` (TS6059). A URL-built specifier is not
 * statically resolved, the same approach check-release-tests.test.ts takes; the
 * shapes below are the part of the module these tests touch.
 */
interface Evidence {
  class: 'ci-native' | 'local-native' | 'mock';
  summary: string;
  files: string[];
  jobs?: string[];
  guard?: string;
  noSkip?: string;
  command?: string;
}
interface Cell {
  value: 'yes' | 'partial' | 'no';
  evidence?: string;
  note?: string;
}
interface Route {
  id: string;
  status: 'active' | 'deferred' | 'maintenance' | 'refused';
  summary: string;
  exports: string[];
  versions: { ci: Array<{ job: string }> };
  evidence: Record<string, Evidence>;
  cells: Record<string, Cell>;
}
interface SupportData {
  features: Array<{ id: string; core: boolean }>;
  routes: Route[];
}
interface RepoContext {
  exports: string[];
  gatesJobs: Map<string, string>;
  nightlyJobs: Map<string, string>;
}
interface Generator {
  loadData(): SupportData;
  readContext(): RepoContext;
  validate(data: SupportData, ctx: RepoContext): string[];
  jobRunsFile(ctx: RepoContext, job: string, file: string, via?: string[]): boolean;
  earnedTier(data: SupportData, route: Route): string;
  routeTier(data: SupportData, route: Route): string;
  renderMarkdown(data: SupportData): string;
  renderSite(data: SupportData): string;
}

const GENERATOR_URL = new URL('../../scripts/gen-engine-support.ts', import.meta.url);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { earnedTier, jobRunsFile, loadData, readContext, renderMarkdown, renderSite, routeTier, validate } =
  (await import(GENERATOR_URL.href)) as Generator;

const ctx = readContext();
const data = loadData();

function copy(): SupportData {
  return structuredClone(data);
}

function route(d: SupportData, id: string): Route {
  const found = d.routes.find((r) => r.id === id);
  assert.ok(found, `route ${id} exists`);
  return found;
}

function problemsMatching(d: SupportData, pattern: RegExp, context: RepoContext = ctx): string[] {
  const problems = validate(d, context);
  assert.ok(
    problems.some((p) => pattern.test(p)),
    `expected a problem matching ${pattern}, got:\n${problems.join('\n')}`,
  );
  return problems;
}

// These suites register tests unconditionally and fail on missing native prerequisites.
const ALWAYS_ON_NATIVE = new Set([
  'src/test/libsql-local.test.ts',
  'src/test/libsql-introspection.test.ts',
  'src/test/libsql-seed.test.ts',
  'src/test/libsql-seed-cli.test.ts',
  'src/test/libsql-native-deploy.test.ts',
  'src/test/d1-introspection.test.ts',
  'src/test/d1-seed.test.ts',
]);

function alwaysOnProblems(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const problems: string[] = [];
  const registrations = new Set<string>();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.getText(tree) !== "'node:test'") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        if (['test', 'it', 'describe'].includes((specifier.propertyName ?? specifier.name).text)) {
          registrations.add(specifier.name.text);
        }
      }
    }
  }
  function staticCases(node: ts.Node): boolean {
    if (ts.isArrayLiteralExpression(node)) return node.elements.length > 0 && node.elements.every(staticCases);
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined') return true;
      return tree.statements.some(
        (statement) =>
          ts.isVariableStatement(statement) &&
          (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
          statement.declarationList.declarations.some(
            (declaration) =>
              ts.isIdentifier(declaration.name) &&
              declaration.name.text === node.text &&
              declaration.initializer &&
              ts.isArrayLiteralExpression(declaration.initializer) &&
              staticCases(declaration.initializer),
          ),
      );
    }
    return (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Error' &&
      (node.arguments ?? []).every((argument) => ts.isStringLiteral(argument))
    );
  }
  function unconditionalRegistration(statement: ts.Node): boolean {
    let parent = statement.parent;
    let child = statement;
    while (parent !== tree) {
      if (ts.isBlock(parent)) {
        child = parent;
        parent = parent.parent;
      } else if (ts.isForOfStatement(parent) && parent.statement === child && staticCases(parent.expression)) {
        child = parent;
        parent = parent.parent;
      } else return false;
    }
    return true;
  }
  let calls = 0;
  function visit(node: ts.Node): void {
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && ['skip', 'todo', 'skipGate'].includes(node.text)) {
      problems.push(`${file} (always-on): forbidden ${node.text} token can hide a skipped or unfinished test`);
    }
    if (
      ts.isIdentifier(node) &&
      registrations.has(node.text) &&
      !ts.isImportSpecifier(node.parent) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      const call = node.parent;
      if (!ts.isCallExpression(call) || call.expression !== node) {
        problems.push(`${file} (always-on): ${node.text} must be called directly, never selected by a prerequisite`);
      } else {
        calls++;
        if (!ts.isExpressionStatement(call.parent) || !unconditionalRegistration(call.parent)) {
          problems.push(
            `${file} (always-on): test registration must be unconditional, with only fixed literal case loops`,
          );
        }
        if (call.arguments.length > 2) {
          const options = call.arguments[1]!;
          if (
            !ts.isObjectLiteralExpression(options) ||
            options.properties.some(
              (property) =>
                ts.isSpreadAssignment(property) || !property.name || ts.isComputedPropertyName(property.name),
            )
          )
            problems.push(`${file} (always-on): test options must be explicit and cannot depend on a prerequisite`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!calls) problems.push(`${file} (always-on): no unconditional node:test registrations found`);
  // No top-level prerequisite branch may exit successfully before registration.
  for (const statement of tree.statements) {
    if (ts.isIfStatement(statement) || ts.isTryStatement(statement) || ts.isSwitchStatement(statement)) {
      problems.push(`${file} (always-on): top-level prerequisite control flow can bypass registration`);
    }
  }
  return problems;
}

/** Native citations must fail when their required prerequisite would otherwise skip. */
function nativeGateProblems(d: SupportData): string[] {
  const problems: string[] = [];
  for (const r of d.routes) {
    for (const [id, evidence] of Object.entries(r.evidence)) {
      if (evidence.class === 'mock') continue;
      for (const file of evidence.files) {
        if (!/\.test\.[cm]?[jt]s$/.test(file)) continue;
        const source = readFileSync(join(ROOT, file), 'utf8');
        const at = `route ${r.id} evidence ${id}: ${file}`;
        if (ALWAYS_ON_NATIVE.has(file)) {
          problems.push(...alwaysOnProblems(file, source));
          continue;
        }
        const gated = /\bskipGate\s*\(/.test(source);
        const binding = /if \(process\.env\.TURBINE_REQUIRE_SQLITE_BINDING === '1'\) throw/.test(source);
        const ws = /if \(!hasNative && process\.env\.TURBINE_REQUIRE_NEON_WS === '1'\)\s*\{\s*throw/.test(source);
        const http =
          source.includes("const required = process.env.TURBINE_REQUIRE_NEON_HTTP_NATIVE === '1'") &&
          /skip:\s*!required && !process\.env\.NEON_HTTP_NATIVE_URL/.test(source);
        if (!gated && !binding && !ws && !http) {
          problems.push(`${at} (gated): has no skipGate or required-prerequisite gate; not classified as always-on`);
        }
      }
    }
  }
  return problems;
}

describe('engine support matrix: the data matches the repository', () => {
  it('validates with no problems', () => {
    assert.deepEqual(validate(data, ctx), []);
  });

  it('every native test citation enforces its prerequisite instead of silently skipping', () => {
    assert.deepEqual(nativeGateProblems(data), []);
  });

  it('reads the real workflow and data (anti-vacuous)', () => {
    assert.ok(ctx.gatesJobs.size >= 20, `gates.yml jobs parsed: ${ctx.gatesJobs.size}`);
    for (const job of ['integration-tests', 'mysql-integration', 'sqlite-migrations', 'gates-ok'])
      assert.ok(ctx.gatesJobs.has(job), `gates.yml defines ${job}`);
    assert.ok(ctx.nightlyJobs.has('yugabytedb-integration'));
    assert.ok(ctx.exports.length >= 20, `package exports: ${ctx.exports.length}`);
    assert.ok(data.routes.length >= 15, `routes: ${data.routes.length}`);
    const ciNative = data.routes.flatMap((r) => Object.values(r.evidence)).filter((e) => e.class === 'ci-native');
    assert.ok(ciNative.length >= 30, `ci-native evidence entries checked: ${ciNative.length}`);
  });

  it('docs/engine-support.md and the site table are current', () => {
    assert.equal(
      readFileSync(join(ROOT, 'docs', 'engine-support.md'), 'utf-8'),
      renderMarkdown(data),
      'docs/engine-support.md is stale. Run: npm run gen:engine-support',
    );
    assert.equal(
      readFileSync(join(ROOT, 'site', 'lib', 'engine-support.generated.ts'), 'utf-8'),
      renderSite(data),
      'site/lib/engine-support.generated.ts is stale. Run: npm run gen:engine-support',
    );
  });

  it('the generator --check passes', () => {
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(ROOT, 'scripts', 'gen-engine-support.ts'), '--check'],
      {
        cwd: ROOT,
        encoding: 'utf-8',
      },
    );
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  });
});

describe('engine support matrix: each guard rejects a broken copy', () => {
  it('a package export with no route and no non-engine entry', () => {
    problemsMatching(data, /export \.\/brand-new-engine has no matrix route/, {
      ...ctx,
      exports: [...ctx.exports, './brand-new-engine'],
    });
  });

  it('a route claiming an export package.json does not have', () => {
    const d = copy();
    route(d, 'mysql').exports.push('./mysql/missing');
    problemsMatching(d, /export \.\/mysql\/missing is not in package.json/);
  });

  it('evidence citing a CI job gates.yml does not define', () => {
    const d = copy();
    route(d, 'mysql').evidence.battery!.jobs = ['mysql-integration-renamed'];
    problemsMatching(d, /job mysql-integration-renamed is not defined in gates\.yml/);
  });

  it('ci-native evidence citing a file its job does not run', () => {
    const d = copy();
    route(d, 'mysql').evidence.battery!.files.push('src/test/fixtures/d1/runtime.test.ts');
    problemsMatching(d, /no listed job \(mysql-integration\) runs src\/test\/fixtures\/d1\/runtime\.test\.ts/);
  });

  it('ci-native evidence whose requirement guard the job does not set', () => {
    const d = copy();
    route(d, 'mysql').evidence.battery!.guard = 'TURBINE_REQUIRE_ENGINE: mariadb';
    problemsMatching(d, /guard "TURBINE_REQUIRE_ENGINE: mariadb" appears in none/);
  });

  it('ci-native evidence with neither a guard nor a reason it cannot skip', () => {
    const d = copy();
    delete route(d, 'mysql').evidence.battery!.guard;
    problemsMatching(d, /needs a guard or a noSkip reason/);
  });

  it('a cited file that lacks the native marker (a mock passed off as native)', () => {
    const d = copy();
    route(d, 'mysql').evidence.battery!.files.push('src/test/capabilities-guard.test.ts');
    problemsMatching(d, /capabilities-guard\.test\.ts does not contain its native marker "MYSQL_URL"/);
  });

  it('a native citation to an ungated unit file', () => {
    const d = copy();
    route(d, 'postgresql').evidence.queries!.files.push('src/test/seed-code.test.ts');
    assert.ok(nativeGateProblems(d).some((p) => p.includes('seed-code.test.ts (gated): has no skipGate')));
  });

  it('an always-on citation cannot gain skip options or conditional registration', () => {
    const file = 'src/test/libsql-local.test.ts';
    for (const body of [
      "test('native', { skip }, () => {});",
      "test('native', { skip: true }, () => {});",
      "test.skip('native', () => {});",
      "test('native', { todo: true }, () => {});",
      "if (process.env.DATABASE_URL) test('native', () => {});",
      "for (const value of process.env.NATIVE_CASES ?? []) test('native', () => {});",
      "const active = process.env.DATABASE_URL ? test : () => {}; active('native', () => {});",
      "try { await import('native-peer'); test('native', () => {}); } catch {}",
      "test('native', () => { context.skip(); });",
      "skipGate(false, 'requires node:sqlite'); test('native', () => {});",
    ]) {
      assert.ok(alwaysOnProblems(file, `import { test } from 'node:test'; ${body}`).length, body);
    }
    assert.deepEqual(
      alwaysOnProblems(
        file,
        "import { test } from 'node:test'; const cases = ['a', 'b']; for (const value of cases) test(value, () => {});",
      ),
      [],
    );
  });

  it('a cited file that does not exist', () => {
    const d = copy();
    route(d, 'postgresql').evidence.queries!.files.push('src/test/no-such-suite.test.ts');
    problemsMatching(d, /no-such-suite\.test\.ts does not exist/);
  });

  it('a CI version whose pinned image changed in the workflow', () => {
    const jobs = new Map(ctx.gatesJobs);
    jobs.set('mysql-integration', jobs.get('mysql-integration')!.replace('image: mysql:8', 'image: mysql:9'));
    problemsMatching(data, /pins "image: mysql:8", not found in job mysql-integration/, { ...ctx, gatesJobs: jobs });
  });

  it('a CI version citing a job that does not exist', () => {
    const d = copy();
    route(d, 'postgresql').versions.ci[0]!.job = 'integration-tests-pg18';
    problemsMatching(d, /cites job integration-tests-pg18, which gates\.yml does not define/);
  });

  it('a feature with no cell, and a partial cell with no note', () => {
    const d = copy();
    delete route(d, 'sqlite').cells.vector;
    route(d, 'sqlite').cells.json = { value: 'partial', evidence: 'values' };
    problemsMatching(d, /route sqlite: no cell for feature vector/);
    problemsMatching(d, /route sqlite json: a partial cell needs a note/);
  });

  it('local-native evidence with no command, and mock evidence naming a gates job', () => {
    const d = copy();
    delete route(d, 'powdb-networked').evidence.networked!.command;
    route(d, 'mysql').evidence.unit!.jobs = ['mysql-integration'];
    problemsMatching(d, /local-native evidence needs a command/);
    problemsMatching(d, /only ci-native evidence may name gates\.yml jobs/);
  });

  it('an em-dash in rendered prose', () => {
    const d = copy();
    route(d, 'sqlite').summary = 'In-process — built in.';
    problemsMatching(d, /routes\[\d+\]\.summary: contains an em-dash/);
  });
});

describe('engine support matrix: how a file is reached from a job', () => {
  it('by the test glob behind `npm test`', () => {
    assert.ok(jobRunsFile(ctx, 'integration-tests', 'src/test/sqlite.test.ts'));
  });

  it('by name in an npm script the job runs', () => {
    assert.ok(jobRunsFile(ctx, 'pack-smoke', 'src/test/d1-introspection.test.ts'));
  });

  it('through a runner that names it', () => {
    const runner = 'tooling/optional-pg-transports/source-suite-gate.mjs';
    assert.ok(jobRunsFile(ctx, 'integration-tests', 'src/test/neon-ws-native.test.ts', [runner]));
    // A job whose test glob reaches the file still counts as running it (the file would skip
    // there); the requirement guard is what tells those apart, so the guard check is separate.
    assert.ok(!jobRunsFile(ctx, 'sqlite-migrations', 'src/test/neon-ws-native.test.ts', [runner]));
  });

  it('not by a job that never mentions it', () => {
    assert.ok(!jobRunsFile(ctx, 'sqlite-migrations', 'src/test/mysql.test.ts'));
    assert.ok(!jobRunsFile(ctx, 'no-such-job', 'src/test/sqlite.test.ts'));
  });
});

describe('engine support matrix: the tier rule', () => {
  const core = data.features.filter((f) => f.core).map((f) => f.id);
  const evidence = (cls: Evidence['class']): Evidence => ({ class: cls, summary: 's', files: ['f'] });

  function synthetic(classes: Partial<Record<string, Evidence['class'] | 'none'>>, value: 'yes' | 'no' = 'yes'): Route {
    const r = structuredClone(route(data, 'postgresql'));
    r.evidence = { ci: evidence('ci-native'), local: evidence('local-native'), mock: evidence('mock') };
    for (const id of core) r.cells[id] = { value: 'yes', evidence: 'ci' };
    for (const [id, cls] of Object.entries(classes)) {
      r.cells[id] =
        cls === 'none'
          ? { value, note: 'n' }
          : { value, evidence: cls === 'ci-native' ? 'ci' : cls === 'local-native' ? 'local' : 'mock', note: 'n' };
    }
    return r;
  }

  it('reads core rows only', () => {
    assert.ok(core.length >= 5, `core rows: ${core.join(', ')}`);
    const r = synthetic({});
    r.cells.vector = { value: 'no', note: 'n' };
    assert.equal(earnedTier(data, r), 'Supported');
  });

  it('Supported needs every core row ci-native', () => {
    assert.equal(earnedTier(data, synthetic({})), 'Supported');
    assert.equal(earnedTier(data, synthetic({ upsert: 'local-native' })), 'Preview');
    assert.equal(earnedTier(data, synthetic({ upsert: 'mock' })), 'Experimental');
    assert.equal(earnedTier(data, synthetic({ upsert: 'none' })), 'Experimental');
  });

  it('a core row that is not available makes the route Experimental, whatever its evidence', () => {
    assert.equal(earnedTier(data, synthetic({ 'nested-writes': 'ci-native' }, 'no')), 'Experimental');
  });

  it('a product decision overrides the earned tier but the earned tier is still reported', () => {
    const r = synthetic({});
    r.status = 'deferred';
    assert.equal(routeTier(data, r), 'Deferred');
    assert.equal(earnedTier(data, r), 'Supported');
    r.status = 'maintenance';
    assert.equal(routeTier(data, r), 'Maintenance');
    r.status = 'refused';
    assert.equal(routeTier(data, r), 'Not supported');
  });
});
