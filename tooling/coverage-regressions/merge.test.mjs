import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';

import { createIstanbulMergeReport } from '../../scripts/coverage-istanbul-merge.mjs';

const fixture = readFileSync(new URL('./fixtures/subject.mjs', import.meta.url), 'utf8');

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'turbine-coverage-regression-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'subject.mjs');
  writeFileSync(source, fixture);
  return { root, source };
}

function collect(root, script, code, mode, label) {
  writeFileSync(script, code);
  const directory = join(root, label);
  mkdirSync(directory);
  const runner = join(root, 'runner.mjs');
  writeFileSync(runner, `
    import assert from 'node:assert/strict';
    import { choose, makeNested } from ${JSON.stringify(pathToFileURL(script).href)};
    assert.equal(choose(${mode === 'true'}), ${JSON.stringify(mode === 'true' ? 'chosen' : 'other')});
    assert.equal(typeof makeNested(), 'function');
  `);
  const child = spawnSync(process.execPath, [runner], {
    env: { ...process.env, NODE_V8_COVERAGE: directory },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr);
  const raw = readdirSync(directory).filter((name) => name.endsWith('.json'));
  assert.ok(raw.length > 0);
  return { directory, files: raw.map((name) => join(directory, name)) };
}

async function reportFor(root, script, collections, label) {
  const directory = join(root, label);
  mkdirSync(directory);
  let i = 0;
  for (const collection of collections) {
    for (const file of collection.files) copyFileSync(file, join(directory, `${i++}.json`));
  }
  const report = createIstanbulMergeReport({
    include: [script],
    exclude: [],
    extension: ['.mjs'],
    allowExternal: true,
    excludeNodeModules: true,
    reporter: [],
    reportsDirectory: join(root, 'reports'),
    tempDirectory: directory,
    resolve: '',
    src: [root],
    all: true,
  });
  return report.getCoverageMapFromAllCoverageFiles();
}

function functions(coverage) {
  return Object.entries(coverage.fnMap).map(([key, fn]) => ({
    name: fn.name,
    loc: fn.loc,
    count: coverage.f[key],
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function coveredLocations(coverage, map, hits) {
  return new Set(Object.entries(coverage[map])
    .filter(([key]) => Array.isArray(coverage[hits][key])
      ? coverage[hits][key].some((n) => n > 0) : coverage[hits][key] > 0)
    .map(([, loc]) => JSON.stringify(loc.loc ?? loc)));
}

function assertKnownFunctions(coverage) {
  const result = functions(coverage);
  assert.deepEqual(result.map((fn) => fn.name), ['choose', 'makeNested', 'nestedUntouched', 'untouched']);
  assert.ok(result.find((fn) => fn.name === 'choose').count > 0);
  assert.ok(result.find((fn) => fn.name === 'makeNested').count > 0);
  assert.equal(result.find((fn) => fn.name === 'untouched').count, 0);
  assert.equal(result.find((fn) => fn.name === 'nestedUntouched').count, 0);
  assert.deepEqual(result.map((fn) => fn.loc.start.line), [1, 15, 16, 11]);
  for (const line of [3, 12, 17]) assert.equal(coverage.getLineCoverage()[line], 0);
  assert.ok(Object.entries(coverage.branchMap).some(([key, branch]) =>
    branch.locations.some((loc) => loc.start.line === 2 && loc.end.line >= 3)
    && coverage.b[key].every((count) => count === 0)), 'the never-selected branch stays uncovered');
}

test('process-local maps preserve function identity and the union of executed branches in either order', async (t) => {
  const { root, source } = setup(t);
  const script = join(root, 'generated.mjs');
  const compile = (banner) => transformSync(fixture, {
    sourcefile: source, format: 'esm', sourcemap: 'inline', banner,
  }).code;
  const a = collect(root, script, compile('// short transform'), 'true', 'a');
  const b = collect(root, script, compile('// shifted transform\n'.repeat(30)), 'false', 'b');
  const variants = [];
  for (const [label, inputs] of [['only-a', [a]], ['only-b', [b]], ['ab', [a, b]], ['ba', [b, a]], ['aba', [a, b, a]]]) {
    const map = await reportFor(root, script, inputs, label);
    assert.deepEqual(map.files(), [source]);
    const coverage = map.fileCoverageFor(source);
    assertKnownFunctions(coverage);
    variants.push(coverage);
  }
  const [onlyA, onlyB, ab, ba, aba] = variants;
  const expected = functions(onlyA).map(({ name, loc }) => ({ name, loc }));
  for (const coverage of variants) assert.deepEqual(functions(coverage).map(({ name, loc }) => ({ name, loc })), expected);
  for (const [map, hits] of [['statementMap', 's'], ['fnMap', 'f'], ['branchMap', 'b']]) {
    for (const input of [onlyA, onlyB]) {
      for (const loc of coveredLocations(input, map, hits)) assert.ok(coveredLocations(ab, map, hits).has(loc));
    }
    assert.deepEqual(coveredLocations(ab, map, hits), coveredLocations(ba, map, hits));
    assert.deepEqual(coveredLocations(ab, map, hits), coveredLocations(aba, map, hits));
  }
  assert.ok(Object.values(onlyA.b).some((hits) => hits.every((n) => n === 0)), 'one-sided run leaves an unexecuted branch');
  assert.ok(ab.toSummary().branches.covered > onlyA.toSummary().branches.covered, 'complementary input covers another branch');
  assert.equal(ab.toSummary().functions.total, 4);
  assert.equal(ab.toSummary().functions.covered, 2);
});

test('a process without a source map cannot inherit a different process map for its URL', async (t) => {
  const { root, source } = setup(t);
  const mapped = transformSync(fixture, {
    sourcefile: source, format: 'esm', sourcemap: 'inline', banner: '// padding\n'.repeat(30),
  }).code;
  const a = collect(root, source, mapped, 'true', 'mapped');
  const b = collect(root, source, fixture, 'false', 'plain');
  const plainRaw = JSON.parse(readFileSync(b.files[0], 'utf8'));
  assert.equal(plainRaw['source-map-cache']?.[pathToFileURL(source).href], undefined);
  for (const [label, inputs] of [['map-plain', [a, b]], ['plain-map', [b, a]]]) {
    const map = await reportFor(root, source, inputs, label);
    assert.deepEqual(map.files(), [source]);
    const coverage = map.fileCoverageFor(source);
    assertKnownFunctions(coverage);
    assert.equal(coverage.toSummary().functions.total, 4);
    assert.equal(coverage.toSummary().functions.covered, 2);
  }
});

for (const plain of [false, true]) {
  test(`one process preserves exact query/fragment maps and absence (plain=${plain})`, async (t) => {
    const { root, source } = setup(t);
    const script = join(root, 'generated.mjs');
    const url = pathToFileURL(script).href;
    const aCode = transformSync(fixture, {
      sourcefile: source, format: 'esm', sourcemap: 'inline', banner: '// short',
    }).code;
    const bCode = plain ? fixture : transformSync(fixture, {
      sourcefile: source, format: 'esm', sourcemap: 'inline', banner: '// shifted\n'.repeat(35),
    }).code;
    // Single-module processes are an independent reference for each transform.
    const a = collect(root, script, aCode, 'true', 'reference-a');
    const b = collect(root, script, bCode, 'false', 'reference-b');
    const reference = await reportFor(root, script, [a, b], 'reference-report');
    writeFileSync(join(root, 'a.mjs'), aCode);
    writeFileSync(join(root, 'b.mjs'), bCode);
    const loader = join(root, 'loader.mjs');
    writeFileSync(loader, `
      import { readFile } from 'node:fs/promises';
      export async function load(url, context, next) {
        if (url.startsWith(${JSON.stringify(`${url}?`)})) {
          const label = new URL(url).hash.slice(1);
          return { format: 'module', shortCircuit: true,
            source: await readFile(new URL(label + '.mjs', import.meta.url), 'utf8') };
        }
        return next(url, context);
      }
    `);
    for (const reverse of [false, true]) {
      const directory = join(root, `aliases-${reverse}`);
      mkdirSync(directory);
      const runner = join(root, `aliases-${reverse}.mjs`);
      const imports = ['a', 'b'].map((label) =>
        `const ${label} = await import(${JSON.stringify(`${url}?transform#${label}`)});`);
      writeFileSync(runner, `
        ${reverse ? imports.reverse().join('\n') : imports.join('\n')}
        a.choose(true); a.makeNested(); b.choose(false); b.makeNested();
      `);
      const child = spawnSync(process.execPath, ['--loader', loader, runner], {
        env: { ...process.env, NODE_V8_COVERAGE: directory }, encoding: 'utf8', timeout: 15000,
      });
      assert.equal(child.status, 0, child.stderr);
      const files = readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => join(directory, name));
      const entries = files.flatMap((file) => {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        return raw.result.filter((script) => script.url.startsWith(`${url}?`)).map((script) => ({
          url: script.url, mapped: !!raw['source-map-cache']?.[script.url],
        }));
      });
      assert.equal(entries.length, 2);
      assert.equal(entries.find((entry) => entry.url.endsWith('#a')).mapped, true);
      assert.equal(entries.find((entry) => entry.url.endsWith('#b')).mapped, !plain);
      const map = await reportFor(root, script, [{ files }], `aliases-report-${reverse}`);
      assert.deepEqual(map.files().sort(), reference.files().sort());
      assert.equal(map.files().length, plain ? 2 : 1);
      for (const file of reference.files()) {
        const actual = map.fileCoverageFor(file);
        const expected = reference.fileCoverageFor(file);
        assert.deepEqual(functions(actual), functions(expected));
        assert.deepEqual(actual.getLineCoverage(), expected.getLineCoverage());
        assert.deepEqual(actual.toSummary().toJSON(), expected.toSummary().toJSON());
      }
    }
  });
}

function sameUrlCollection(root, source, script, label, attributed, reverse = false, plain = false, runnerArgs = [], unpreloaded = false) {
  let esm = transformSync(fixture, {
    sourcefile: source, format: 'esm', sourcemap: 'inline', banner: '// ESM transform',
  }).code;
  let second = plain ? fixture : transformSync(fixture, {
    sourcefile: source, format: 'esm', sourcemap: 'inline', banner: '// second transform\n'.repeat(20),
  }).code;
  if (!plain) {
    // Equal emitted lengths cannot identify a map either. These transforms
    // still have different line layouts and different inline mappings.
    const length = Math.max(esm.length, second.length);
    esm = esm.padEnd(length); second = second.padEnd(length);
  }
  writeFileSync(script, esm);
  const runner = join(root, `${label}.mjs`);
  const directory = join(root, label);
  mkdirSync(directory);
  const esLoad = `const a = await import(${JSON.stringify(pathToFileURL(script).href)});`;
  const vmLoad = `const mod = new SourceTextModule(${JSON.stringify(second)}, { identifier: ${JSON.stringify(pathToFileURL(script).href)} });
    await mod.link(() => { throw new Error('unexpected import'); }); await mod.evaluate(); const b = mod.namespace;`;
  writeFileSync(runner, `
    import assert from 'node:assert/strict';
    import { SourceTextModule } from 'node:vm';
    ${reverse ? vmLoad + esLoad : esLoad + vmLoad}
    assert.equal(a.choose(true), 'chosen');
    assert.equal(b.choose(false), 'other');
    a.makeNested(); b.makeNested();
  `);
  const args = attributed ? [fileURLToPath(new URL('./collect.mjs', import.meta.url)),
    '--directory', directory, '--', process.execPath, ...runnerArgs, '--experimental-vm-modules', runner]
    : [...runnerArgs, '--experimental-vm-modules', runner];
  if (unpreloaded) {
    const launcher = join(root, `${label}-launcher.mjs`);
    writeFileSync(launcher, `import { spawnSync } from 'node:child_process';
      const child = spawnSync(process.execPath, ['--experimental-vm-modules', ${JSON.stringify(runner)}],
        { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'inherit' });
      process.exitCode = child.status ?? 1;`);
    args.splice(args.indexOf('--') + 1, args.length, process.execPath, launcher);
  }
  const child = spawnSync(process.execPath, args, {
    env: { ...process.env, NODE_TEST_CONTEXT: undefined,
      NODE_V8_COVERAGE: attributed ? '' : directory, TURBINE_COVERAGE_SOURCE_ROOT: root },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr);
  return { files: readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => join(directory, name)) };
}

test('same-process same-URL transforms fail closed without script attribution', async (t) => {
  const { root, source } = setup(t);
  const script = join(root, 'generated.mjs');
  const collection = sameUrlCollection(root, source, script, 'ambiguous', false);
  const entries = collection.files.flatMap((file) => JSON.parse(readFileSync(file, 'utf8')).result)
    .filter((entry) => entry.url === pathToFileURL(script).href);
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].scriptId, entries[1].scriptId);
  assert.equal(entries[0].functions[0].ranges[0].endOffset, entries[1].functions[0].ranges[0].endOffset);
  await assert.rejects(reportFor(root, script, [collection], 'ambiguous-report'), /ambiguous source-map attribution.*scriptIds=/);
});

test('collection survives the real tsx loader and Node test coordinator without an inspector', async (t) => {
  const { root, source } = setup(t);
  const script = join(root, 'generated.mjs');
  const collection = sameUrlCollection(root, source, script, 'identity-test-runner', true, false, false,
    ['--import', fileURLToPath(import.meta.resolve('tsx')), '--test']);
  const map = await reportFor(root, script, [collection], 'identity-test-runner-report');
  assert.deepEqual(map.files(), [source]);
  assertKnownFunctions(map.fileCoverageFor(source));
});

test('scriptId collection preserves same-URL ESM/VM identities, real zero hits and order invariance', async (t) => {
  const { root, source } = setup(t);
  const script = join(root, 'generated.mjs');
  const a = sameUrlCollection(root, source, script, 'identity-a', true);
  const b = sameUrlCollection(root, source, script, 'identity-b', true, true);
  const reference = [];
  for (const [label, banner, mode] of [['esm', '// ESM transform', 'true'], ['vm', '// second transform\n'.repeat(20), 'false']]) {
    reference.push(collect(root, script, transformSync(fixture, {
      sourcefile: source, format: 'esm', sourcemap: 'inline', banner,
    }).code, mode, `reference-${label}`));
  }
  const expected = (await reportFor(root, script, reference, 'same-url-reference')).fileCoverageFor(source);
  const variants = [];
  for (const [label, inputs] of [['id-a', [a]], ['id-b', [b]], ['id-ab', [a, b]], ['id-ba', [b, a]]]) {
    const map = await reportFor(root, script, inputs, label);
    assert.deepEqual(map.files(), [source]);
    const coverage = map.fileCoverageFor(source);
    assertKnownFunctions(coverage);
    assert.equal(coverage.toSummary().functions.total, 4);
    assert.equal(coverage.toSummary().functions.covered, 2);
    assert.deepEqual(functions(coverage), functions(expected).map((fn) => ({ ...fn, count: fn.count * inputs.length })));
    assert.deepEqual({ ...coverage.getLineCoverage() }, Object.fromEntries(Object.entries(expected.getLineCoverage())
      .map(([line, count]) => [line, count * inputs.length])));
    variants.push(coverage);
  }
  for (const coverage of variants.slice(1)) {
    assert.deepEqual(functions(coverage).map(({ name, loc }) => ({ name, loc })),
      functions(variants[0]).map(({ name, loc }) => ({ name, loc })));
    assert.deepEqual(coveredLocations(coverage, 'branchMap', 'b'), coveredLocations(variants[0], 'branchMap', 'b'));
    assert.deepEqual(coveredLocations(coverage, 'statementMap', 's'), coveredLocations(variants[0], 'statementMap', 's'));
  }
});

test('same-URL collision capture preserves a genuinely unmapped transform', async (t) => {
  const { root, source } = setup(t);
  const script = join(root, 'generated.mjs');
  const collection = sameUrlCollection(root, source, script, 'identity-plain', true, false, true);
  const map = await reportFor(root, script, [collection], 'identity-plain-report');
  assert.deepEqual(map.files().sort(), [source, script].sort());
  for (const file of map.files()) assertKnownFunctions(map.fileCoverageFor(file));
});

test('mismatched script attribution and incomplete collections fail before c8 can swallow errors', async (t) => {
  const { root, source } = setup(t);
  const script = join(root, 'generated.mjs');
  const collection = sameUrlCollection(root, source, script, 'identity-invalid', true);
  for (const file of collection.files) {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    for (const captured of Object.values(raw['turbine-script-maps'].scripts)) captured.url += '?wrong-transform';
    writeFileSync(file, JSON.stringify(raw));
  }
  await assert.rejects(reportFor(root, script, [collection], 'identity-invalid-report'), /invalid script attribution/);
  mkdirSync(join(root, 'identity-unfinished', '.capture-interrupted'), { recursive: true });
  const report = createIstanbulMergeReport({ tempDirectory: join(root, 'identity-unfinished'), reporter: [] });
  await assert.rejects(report.getCoverageMapFromAllCoverageFiles(), /unfinished attributed collection/);
});

test('unpreloaded subprocess coverage is retained, while a started missing capture stays fatal', async (t) => {
  const { root, source } = setup(t);
  const script = join(root, 'generated.mjs');
  writeFileSync(script, transformSync(fixture, { sourcefile: source, format: 'esm', sourcemap: 'inline' }).code);
  for (const started of [false, true]) {
    const directory = join(root, `unpreloaded-${started}`);
    const runner = join(root, `child-${started}.mjs`);
    writeFileSync(runner, `import { writeFileSync } from 'node:fs';
      if (${started}) writeFileSync(process.env.TURBINE_COVERAGE_CAPTURE_DIRECTORY + '/owner-' + process.pid + '-0', '', { flag: 'wx' });
      const { choose, makeNested } = await import(${JSON.stringify(pathToFileURL(script).href)});
      if (choose(false) !== 'other' || typeof makeNested() !== 'function') throw new Error('unexpected value');`);
    const launcher = join(root, `launcher-${started}.mjs`);
    writeFileSync(launcher, `import { spawnSync } from 'node:child_process';
      const child = spawnSync(process.execPath, [${JSON.stringify(runner)}],
        { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'inherit' });
      process.exitCode = child.status ?? 1;`);
    const run = spawnSync(process.execPath,
      [fileURLToPath(new URL('./collect.mjs', import.meta.url)), '--directory', directory, '--', process.execPath, launcher],
      { env: { ...process.env, NODE_TEST_CONTEXT: undefined, TURBINE_COVERAGE_SOURCE_ROOT: root }, encoding: 'utf8', timeout: 15000 });
    if (started) {
      assert.equal(run.status, 1);
      assert.match(run.stderr, /collection attribution failed: ENOENT.*maps-/);
      continue;
    }
    assert.equal(run.status, 0, run.stderr);
    const files = readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => join(directory, name));
    const raw = files.map((file) => JSON.parse(readFileSync(file, 'utf8'))).find((r) => r['turbine-capture-status'] === 'preload-not-run');
    assert.ok(raw?.result.some((s) => s.url === pathToFileURL(script).href));
    assert.equal(raw['turbine-script-maps'], undefined, 'absence is not fabricated attribution');
    const map = await reportFor(root, script, [{ files }], 'unpreloaded-report');
    const fns = functions(map.fileCoverageFor(source));
    assert.ok(fns.find((fn) => fn.name === 'choose').count > 0);
    assert.ok(fns.find((fn) => fn.name === 'makeNested').count > 0);
    for (const name of ['untouched', 'nestedUntouched']) assert.equal(fns.find((fn) => fn.name === name).count, 0);
  }
});

test('an unpreloaded subprocess collision remains an attribution error at reporting', async (t) => {
  const { root, source } = setup(t);
  const script = join(root, 'generated.mjs');
  const collection = sameUrlCollection(root, source, script, 'unpreloaded-collision', true, false, false, [], true);
  await assert.rejects(reportFor(root, script, [collection], 'unpreloaded-collision-report'), /ambiguous source-map attribution.*scriptIds=/);
});
