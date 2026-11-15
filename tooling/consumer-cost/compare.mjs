/** Matched PostgreSQL extension of measure-consumer-cost, not a query timing suite. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleSchemaVersion, roleManifest, validateRole, commonIdentity, admitRoles, physicalTree, payloadTree, deployRuntime, verifyRuntimePayload, importedRuntimeFiles } from './runtime-role-closure.mjs';
import { processMonitor } from '../../scripts/measure-consumer-cost-fixtures.mjs';
import {
  comparisonPins, comparisonSchema, comparisonEntry, comparisonWorkload, comparisonProbe, comparisonOracle, minimalDrizzleSource,
} from './comparison-fixtures.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = async p => JSON.parse(await readFile(p, 'utf8'));
const save = async (p, v) => writeFile(p, `${JSON.stringify(v, null, 2)}\n`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceFiles = ['scripts/measure-consumer-cost.mjs', 'scripts/measure-consumer-cost-fixtures.mjs',
  'scripts/measure-consumer-cost-resources.mjs', 'tooling/consumer-cost/compare.mjs', 'tooling/consumer-cost/comparison-fixtures.mjs', 'tooling/consumer-cost/runtime-role-closure.mjs'];
const bad = result => result.status !== 'measured';

export function parseComparison(argv) {
  const o = { sizes: [5], arms: Object.keys(comparisonPins.arms), formats: ['esm', 'cjs'], iterations: 3,
    timeoutMs: 180000, compilerHeapMb: 4096, installMode: 'offline-cache' };
  const flags = { '--tarball': 'tarball', '--sha256': 'sha256', '--prepare-locks': 'prepareLocks', '--locks': 'locks',
    '--formats': 'formats', '--out': 'out', '--work-root': 'workRoot', '--cache': 'cache', '--sizes': 'sizes', '--arms': 'arms',
    '--iterations': 'iterations', '--timeout-ms': 'timeoutMs', '--compiler-heap-mb': 'compilerHeapMb',
    '--install-mode': 'installMode', '--pg-url': 'pgUrl' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--compare') continue;
    if (argv[i] === '--install-only') { o.installOnly = true; continue; }
    if (argv[i] === '--allow-network') { o.allowNetwork = true; continue; }
    if (argv[i] === '--help') { o.help = true; continue; }
    const key = flags[argv[i]];
    assert.ok(key && argv[i + 1] && !argv[i + 1].startsWith('--'), `Invalid comparison option: ${argv[i]}`);
    o[key] = argv[++i];
  }
  if (o.help) return o;
  for (const key of ['tarball', 'workRoot', 'cache']) { assert.ok(o[key], `--${key} required`); o[key] = resolve(o[key]); }
  assert.match(o.sha256 ?? '', /^[a-f0-9]{64}$/, 'Explicit --sha256 required');
  assert.notEqual(Boolean(o.prepareLocks), Boolean(o.locks), 'Use exactly one of --prepare-locks / --locks');
  if (o.locks) assert.ok(o.out, '--out required');
  for (const key of ['prepareLocks', 'locks', 'out']) if (o[key]) o[key] = resolve(o[key]);
  for (const key of ['sizes', 'arms', 'formats']) if (typeof o[key] === 'string') o[key] = o[key].split(',');
  o.sizes = o.sizes.map(Number);
  assert.ok(o.sizes.length && o.sizes.every(n => Number.isSafeInteger(n) && n >= 3 && n <= 1000), 'Sizes must be 3..1000');
  assert.ok(o.arms.length && o.arms.every(n => Object.hasOwn(comparisonPins.arms, n)), 'Unknown comparison arm');
  assert.ok(o.formats.length && o.formats.every(f => ['esm', 'cjs'].includes(f)), 'Unknown format');
  for (const key of ['sizes', 'arms', 'formats']) assert.equal(new Set(o[key]).size, o[key].length, `Duplicate ${key}`);
  for (const key of ['iterations', 'timeoutMs', 'compilerHeapMb']) {
    o[key] = Number(o[key]); assert.ok(Number.isSafeInteger(o[key]) && o[key] > 0, `Invalid ${key}`);
  }
  assert.ok(['offline-cache', 'registry-cold', 'cache-fill'].includes(o.installMode), 'Unknown install mode');
  assert.ok(o.installMode === 'offline-cache' || o.allowNetwork, 'Network mode requires --allow-network');
  if (o.locks && o.installMode === 'offline-cache')
    assert.equal(Boolean(o.allowNetwork), false, 'Offline-cache must forbid network; select cache-fill or registry-cold');
  if (o.pgUrl) {
    const u = new URL(o.pgUrl);
    assert.ok(['postgres:', 'postgresql:'].includes(u.protocol) && ['127.0.0.1', '[::1]'].includes(u.hostname), 'Only explicit owned loopback PostgreSQL supported');
    assert.equal(u.password, '', 'No credentials accepted');
  }
  const distinct = ['workRoot', 'cache', 'out', 'prepareLocks', 'locks'].filter(k => o[k]);
  assert.equal(new Set(distinct.map(k => o[k])).size, distinct.length, 'Work, cache, locks and evidence paths must differ');
  return o;
}

async function tree(dir, prefix = '') {
  const files = {};
  for (const ent of (await readdir(join(dir, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = join(prefix, ent.name);
    if (ent.isDirectory()) Object.assign(files, await tree(dir, name));
    else if (ent.isFile()) { const bytes = await readFile(join(dir, name)); files[name] = { bytes: bytes.length, sha256: hash(bytes) }; }
    // npm executable links are not followed.
  }
  return files;
}

export async function installedInventory(project, lock) {
  await physicalTree(project);
  const payload = await payloadTree(join(project, 'node_modules'), true);
  const packages = [];
  for (const file of Object.keys(payload).filter(f => /^(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*\/package\.json$/.test(f))) {
    const path = 'node_modules/' + file.slice(0, -'/package.json'.length);
    const item = lock.packages[path];
    assert.ok(item, `Installed package absent from role lock: ${path}`);
    const actual = await readJson(join(project, path, 'package.json'));
    if (item.version) assert.equal(actual.version, item.version, `Installed/locked version mismatch: ${path}`);
    packages.push({ path, name: actual.name, version: actual.version, dev: Boolean(item.dev),
      devOptional: Boolean(item.devOptional), optional: Boolean(item.optional), peer: Boolean(item.peer), integrity: item.integrity ?? null,
      resolved: item.resolved ?? null, manifestSha256: payload[`${path.slice('node_modules/'.length)}/package.json`]?.sha256 });
  }
  return { packages, payload, bytes: Object.values(payload).reduce((s, f) => s + f.bytes, 0), files: Object.keys(payload).length,
    installedPayloadSha256: hash(JSON.stringify(payload)), mandatoryPg: {
      declared: Boolean((await readJson(join(project, 'node_modules', packages.some(p => p.name === 'turbine-orm') ? 'turbine-orm' : 'pg', 'package.json'))).dependencies?.pg),
      installed: packages.filter(p => p.name === 'pg').map(p => ({ path: p.path, version: p.version })),
    } };
}

export async function compareConsumers(argv, { command, compileConsumer, packedMetadata }) {
  const o = parseComparison(argv);
  if (o.help) { console.log('Use --compare --tarball PATH --sha256 HASH --work-root NEW_PATH --cache PATH --prepare-locks NEW_PATH [--allow-network], then --locks PATH --out NEW_PATH. See tooling/consumer-cost/COMPARISON.md.'); return 0; }
  const candidate = packedMetadata(await readFile(o.tarball));
  assert.equal(candidate.tarballSha256, o.sha256, 'Archive SHA256 mismatch');
  const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async f => [f, hash(await readFile(join(root, f)))])));
  const definitionsHash = hash(JSON.stringify(comparisonPins));
  // Exclusive mkdir admission prevents accidental reuse, including a failed earlier campaign.
  await mkdir(o.workRoot);
  await writeFile(join(o.workRoot, 'empty.npmrc'), ''); await writeFile(join(o.workRoot, 'global.npmrc'), '');
  const evidenceRoot = o.prepareLocks ?? o.out;
  await mkdir(evidenceRoot);
  const report = { schemaVersion: roleSchemaVersion, scope: 'Exploratory consumer costs; no accepted timing or performance win. PostgreSQL only; Prisma 8 excluded.',
    candidate, sources, pins: comparisonPins, node: { version: process.version, binary: process.execPath,
      sha256: hash(await readFile(process.execPath)), versions: process.versions }, installMode: o.installMode,
    limits: { timeoutMs: o.timeoutMs, compilerHeapMb: o.compilerHeapMb }, arms: {}, commands: [] };
  await writeFile(join(o.workRoot, 'process-monitor.mjs'), processMonitor);
  const log = async (binary, args, cwd, dir, name, extraEnv = {}) => {
    await mkdir(dir, { recursive: true });
    const resourceFile = join(dir, `${name}.resource.json`);
    await writeFile(join(cwd, 'monitor.mjs'), processMonitor);
    const monitoredArgs = binary === process.execPath ? ['--import', join(cwd, 'monitor.mjs'), ...args] : args;
    const result = await command(binary, monitoredArgs, { cwd, home: o.workRoot, timeoutMs: o.timeoutMs, observeResources: true,
      env: { ...extraEnv, CONSUMER_COST_RESOURCE_FILE: resourceFile, TMPDIR: o.workRoot } });
    await writeFile(join(dir, `${name}.stdout.txt`), result.stdout);
    await writeFile(join(dir, `${name}.stderr.txt`), result.stderr);
    const { stdout, stderr, ...summary } = result;
    summary.resources = existsSync(resourceFile) ? await readJson(resourceFile) : { status: 'unavailable' };
    summary.resourceScope = 'Main child process CPU/RSS, no descendant attribution';
    await save(join(dir, `${name}.command.json`), { binary, args: monitoredArgs, cwd, ...summary });
    report.commands.push({ binary, args, cwd, evidence: join(dir, `${name}.command.json`), status: result.status });
    return summary;
  };
  const npmExecutable = process.env.CONSUMER_COST_NPM ?? process.env.PATH.split(':').map(p => join(p, 'npm')).find(p => existsSync(p));
  const npmCli = resolve(dirname(await import('node:fs/promises').then(fs => fs.realpath(npmExecutable))), 'npm-cli.js');
  assert.ok(existsSync(npmCli), 'npm CLI not found; set CONSUMER_COST_NPM to npm executable');
  report.npm = { cli: npmCli, sha256: hash(await readFile(npmCli)),
    version: (await command(process.execPath, [npmCli, '--version'], { cwd: o.workRoot })).stdout.trim() };
  const npm = async (project, dir, name, args) => {
    let cache = o.cache;
    if (o.installMode === 'registry-cold' && args[0] === 'ci') {
      cache = join(o.workRoot, `empty-cache-${name}-${report.commands.length}`); await mkdir(cache);
    }
    await writeFile(join(project, 'monitor.mjs'), processMonitor);
    const resourceFile = join(dir, `${name}.resource.json`);
    const result = await log(process.execPath, [npmCli, ...args,
      '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org',
      '--userconfig', join(o.workRoot, 'empty.npmrc'), '--globalconfig', join(o.workRoot, 'global.npmrc'),
      '--cache', cache, ...(o.allowNetwork ? [] : ['--offline'])], project, dir, name,
      { CONSUMER_COST_RESOURCE_FILE: resourceFile });
    return { ...result, cache, resources: existsSync(resourceFile) ? await readJson(resourceFile) : { status: 'unavailable' },
      resourceScope: 'npm process CPU/RSS only; external samples exclude descendants; scripts disabled',
      mode: o.installMode, network: o.allowNetwork ? 'allowed; cache-fill is not registry-cold' : 'offline' };
  };
  const lockMeta = o.locks ? await readJson(join(o.locks, 'comparison-locks.json')) : {
    schemaVersion: roleSchemaVersion, candidateSha256: o.sha256, definitionsHash, arms: {},
  };
  assert.equal(lockMeta.schemaVersion, roleSchemaVersion, 'Separate role locks v2 required; historical one-lock evidence is incompatible');
  assert.equal(lockMeta.candidateSha256, o.sha256, 'Candidate/lock mismatch');
  assert.equal(lockMeta.definitionsHash, definitionsHash, 'Comparison pins changed');
  try {
    for (const arm of o.arms) {
      const armRoot = join(o.workRoot, arm); const dir = join(evidenceRoot, arm);
      await mkdir(armRoot); await mkdir(dir);
      const project = join(armRoot, 'tooling'), runtimeProject = join(armRoot, 'runtime');
      for (const path of [project, runtimeProject]) { await mkdir(path); await copyFile(o.tarball, join(path, 'candidate.tgz')); }
      const armReport = report.arms[arm] = { roles: { tooling: project, runtime: runtimeProject } };
      if (o.prepareLocks) {
        const roles = {}; let toolingLock;
        for (const role of ['tooling', 'runtime']) {
          const path = role === 'tooling' ? project : runtimeProject;
          const roleDir = join(dir, role); await mkdir(roleDir);
          const manifest = roleManifest(arm, role, toolingLock);
          await save(join(path, 'package.json'), manifest);
          armReport[`${role}Lock`] = await npm(path, roleDir, 'lock', ['install', '--package-lock-only', ...(role === 'tooling' ? ['--include=dev'] : [])]);
          if (bad(armReport[`${role}Lock`])) throw new Error(`Role lock preparation failed: ${arm}/${role}`);
          const lock = await readJson(join(path, 'package-lock.json'));
          validateRole(arm, role, manifest, lock, toolingLock);
          if (role === 'tooling') toolingLock = lock;
          const saved = { role };
          for (const f of ['package.json', 'package-lock.json']) { await copyFile(join(path, f), join(roleDir, f)); saved[f] = hash(await readFile(join(path, f))); }
          roles[role] = saved;
        }
        lockMeta.arms[arm] = { roles, commonIdentity: commonIdentity(await readJson(join(runtimeProject, 'package-lock.json')), toolingLock) };
        await save(join(evidenceRoot, 'comparison-locks.json'), lockMeta);
        continue;
      }
      const admitted = await admitRoles(lockMeta, o.locks, arm);
      for (const role of ['tooling', 'runtime']) {
        const path = role === 'tooling' ? project : runtimeProject;
        await mkdir(join(dir, role));
        for (const f of ['package.json', 'package-lock.json']) {
          await writeFile(join(path, f), admitted[role][f]); await writeFile(join(dir, role, f), admitted[role][f]);
        }
      }
      const runtimeLock = await readJson(join(runtimeProject, 'package-lock.json'));
      armReport.installation = await npm(runtimeProject, dir, 'runtime-install', ['ci', '--omit=dev']);
      if (bad(armReport.installation)) { armReport.status = 'failed'; continue; }
      const initialRuntime = await installedInventory(runtimeProject, runtimeLock);
      const runtimePayload = initialRuntime.payload;
      armReport.productionInventory = { ...initialRuntime }; delete armReport.productionInventory.payload;
      await save(join(dir, 'production-payload.json'), runtimePayload);
      if (o.installOnly) { armReport.status = 'measured'; armReport.omitted = 'Explicit install-only run: tooling install and compiler/import/init/native operations omitted'; continue; }
      armReport.tools = await npm(project, dir, 'tooling-install', ['ci', '--include=dev']);
      armReport.runtimeAfterTooling = await verifyRuntimePayload(runtimeProject, runtimePayload);
      if (bad(armReport.tools)) { armReport.status = 'failed'; continue; }
      await physicalTree(project);
      const toolInventory = await installedInventory(project, await readJson(join(project, 'package-lock.json')));
      await save(join(dir, 'tooling-payload.json'), toolInventory);
      if (arm.startsWith('drizzle-')) {
        armReport.minimalInstalled = {};
        for (const format of o.formats) for (const relations of [false, true]) {
          const label = `${format}-${relations ? 'relations' : 'driver'}`;
          const minimalDir = join(dir, `minimal-${label}`); await mkdir(minimalDir);
          const ext = format === 'esm' ? 'mts' : 'cts';
          const source = minimalDrizzleSource(arm, format, relations);
          await writeFile(join(project, `minimal.${ext}`), source);
          const config = { compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
            strict: true, skipLibCheck: false, noEmit: true, types: ['node'] }, files: [`minimal.${ext}`] };
          await save(join(project, 'tsconfig.json'), config);
          await writeFile(join(minimalDir, `minimal.${ext}`), source); await save(join(minimalDir, 'tsconfig.json'), config);
          armReport.minimalInstalled[label] = await compileConsumer(project, minimalDir, o);
        }
      }
      armReport.cases = [];
      for (const tables of o.sizes) for (const format of o.formats) {
        const caseDir = join(dir, `${tables}-${format}`); await mkdir(caseDir);
        const fixture = join(project, 'fixture'); await rm(fixture, { recursive: true, force: true }); await mkdir(fixture);
        await save(join(fixture, 'package.json'), { private: true, type: format === 'esm' ? 'module' : 'commonjs' });
        await physicalTree(project); // Authored/generated source must resolve only tooling's own dependencies.
        const ext = format === 'esm' ? 'ts' : 'cts';
        const authoringStart = performance.now();
        const authored = comparisonSchema(arm, tables, format);
        for (const [file, source] of Object.entries(authored)) await writeFile(join(fixture, file), source);
        const c = { tables, format, status: 'failed', authoring: { fixtureEmissionMs: performance.now() - authoringStart,
          scope: 'Deterministic fixture emitter, not human authoring effort; authored schema bytes separate from generated declarations', files: {} } };
        armReport.cases.push(c);
        for (const [file, source] of Object.entries(authored)) { c.authoring.files[file] = { bytes: Buffer.byteLength(source), sha256: hash(source) }; await copyFile(join(fixture, file), join(caseDir, file)); }
        c.authoring.bytes = Object.values(c.authoring.files).reduce((sum, f) => sum + f.bytes, 0);
        if (arm === 'turbine') {
          await writeFile(join(fixture, 'generate.mjs'), `import { readFileSync } from 'node:fs';\nimport { generate } from 'turbine-orm';\nconst schema = JSON.parse(readFileSync('schema.json'));\nfor (const t of Object.values(schema.tables)) t.dateColumns = new Set(['created_at']);\ngenerate({ schema, outDir: './generated', noTimestamp: true, importExtension: 'js' });\n`);
          await copyFile(join(fixture, 'generate.mjs'), join(caseDir, 'generate.mjs'));
          c.generation = await log(process.execPath, ['generate.mjs'], fixture, caseDir, 'generate');
        } else if (arm === 'prisma') {
          c.generation = await log(process.execPath, [join(project, 'node_modules/prisma/build/index.js'), 'generate', '--schema', 'schema.prisma'], fixture, caseDir, 'generate',
            { PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' });
        } else c.generation = { status: 'not-applicable', reason: 'Drizzle infers directly from authored TypeScript; no generated client or Kit cost is invented' };
        if (!['measured', 'not-applicable'].includes(c.generation.status)) continue;
        if (existsSync(join(fixture, 'generated'))) {
          c.generated = await tree(join(fixture, 'generated'));
          c.generatedBytes = Object.values(c.generated).reduce((sum, f) => sum + f.bytes, 0);
          for (const f of Object.keys(c.generated)) { await mkdir(dirname(join(caseDir, 'generated', f)), { recursive: true }); await copyFile(join(fixture, 'generated', f), join(caseDir, 'generated', f)); }
        }
        const entry = comparisonEntry(arm, format); const workload = comparisonWorkload(arm, tables, format);
        await writeFile(join(fixture, `entry.${ext}`), entry);
        const config = { compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
          strict: true, skipLibCheck: false, noEmit: true, incremental: false, types: ['node'], outDir: './out' }, files: [`entry.${ext}`] };
        await save(join(fixture, 'tsconfig.json'), config);
        // Compile from the physical tooling root; no node_modules bridge is needed.
        const compileFixture = async evidence => {
          const toolingConfig = { ...config, compilerOptions: { ...config.compilerOptions, rootDir: './fixture', outDir: './fixture/out' },
            files: config.files.map(f => `fixture/${f}`) };
          await save(join(project, 'tsconfig.json'), toolingConfig);
          await save(join(evidence, 'tooling-tsconfig.json'), toolingConfig);
          return compileConsumer(project, evidence, o);
        };
        await save(join(caseDir, 'declarations-tsconfig.json'), config);
        c.declarations = await compileFixture(caseDir);
        for (const f of ['typecheck.stdout.txt', 'typecheck.stderr.txt', 'typecheck.command.json', 'compiler-resource.json'])
          if (existsSync(join(caseDir, f))) await copyFile(join(caseDir, f), join(caseDir, `declarations-${f}`));
        await writeFile(join(fixture, `workload.${ext}`), workload); config.files.push(`workload.${ext}`);
        await save(join(fixture, 'tsconfig.json'), config);
        for (const f of [`entry.${ext}`, `workload.${ext}`, 'tsconfig.json', 'package.json']) await copyFile(join(fixture, f), join(caseDir, f));
        c.workload = await compileFixture(caseDir);
        c.compiler = { typescript: (await readJson(join(project, 'node_modules/typescript/package.json'))).version,
          nodeTypes: (await readJson(join(project, 'node_modules/@types/node/package.json'))).version };
        // Preserve full strict failures. A supplemental pass checks consumer expressions
        // with library declaration checking disabled, never relabeled as a strict pass.
        let consumerChecked = !bad(c.workload);
        if (!consumerChecked) {
          config.compilerOptions.skipLibCheck = true;
          await save(join(fixture, 'tsconfig.json'), config);
          const supplementalDir = join(caseDir, 'consumer-only'); await mkdir(supplementalDir);
          await save(join(supplementalDir, 'tsconfig.json'), config);
          c.consumerOnly = await compileFixture(supplementalDir);
          consumerChecked = !bad(c.consumerOnly);
        }
        // Remove suppression directives in a second real compile; assert every intended invalid line fails.
        if (tables === Math.min(...o.sizes)) {
          const invalid = workload.replaceAll('@ts-expect-error', 'invalid-control');
          await writeFile(join(fixture, `workload.${ext}`), invalid);
          const negDir = join(caseDir, 'negative-controls'); await mkdir(negDir);
          await save(join(negDir, 'tsconfig.json'), config);
          await writeFile(join(negDir, `workload.${ext}`), invalid);
          const negative = await compileFixture(negDir);
          await writeFile(join(fixture, `workload.${ext}`), workload);
          const diagnostics = await readFile(join(negDir, 'typecheck.stdout.txt'), 'utf8');
          const lines = invalid.split('\n').flatMap((line, i) => line.includes('// invalid-control') ? [i + 2] : []);
          const missing = lines.filter(line => !diagnostics.includes(`workload.${ext}(${line},`));
          c.negative = { status: negative.status === 'failed' && missing.length === 0 ? (consumerChecked ? 'measured' : 'unavailable') : 'failed',
            baselineConsumerPassed: consumerChecked, reason: consumerChecked ? null : 'Positive consumer has diagnostics; invalid-line errors observed, no passing type contract claimed',
            intendedErrors: lines.length, missing, compilerStatus: negative.status };
          if (c.negative.status === 'failed') continue;
        }
        c.emit = await log(process.execPath, [join(project, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit', 'false', '--noCheck'], fixture, caseDir, 'emit');
        if (bad(c.emit)) continue;
        // Prisma JS codegen files are not emitted by tsc; copy the real generated runtime beside emitted entry.
        if (arm === 'prisma') { const { cp } = await import('node:fs/promises'); await cp(join(fixture, 'generated'), join(fixture, 'out/generated'), { recursive: true }); }
        const runtimeFixture = join(runtimeProject, 'fixtures', `${tables}-${format}`);
        await mkdir(runtimeFixture, { recursive: true });
        await copyFile(join(fixture, 'package.json'), join(runtimeFixture, 'package.json'));
        c.emittedRuntimePayload = await deployRuntime(fixture, runtimeFixture, arm, format);
        await physicalTree(runtimeProject);
        c.emittedRuntimeBytes = Object.values(c.emittedRuntimePayload).reduce((sum, f) => sum + f.bytes, 0);
        await writeFile(join(runtimeFixture, 'probe.mjs'), comparisonProbe(format));
        await copyFile(join(runtimeFixture, 'probe.mjs'), join(caseDir, 'probe.mjs'));
        c.runtime = [];
        for (let n = 0; n < o.iterations; n++) {
          const dest = join(caseDir, `runtime-${n}.json`);
          const result = await log(process.execPath, ['probe.mjs', dest], runtimeFixture, caseDir, `runtime-${n}`);
          c.runtime.push({ ...result, sample: result.status === 'measured' ? await readJson(dest) : null });
        }
        // A separate V8 coverage process inventories actual imported files, outside runtime samples.
        const coverage = join(caseDir, 'coverage'); await mkdir(coverage);
        c.importGraph = await log(process.execPath, ['probe.mjs', join(caseDir, 'instrumented.json')], runtimeFixture, caseDir, 'import-graph', { NODE_V8_COVERAGE: coverage });
        const urls = [];
        for (const f of await readdir(coverage)) for (const item of (await readJson(join(coverage, f))).result) urls.push(item.url);
        c.importGraph.modules = await importedRuntimeFiles(urls, runtimeProject);
        c.runtimeIdentity = Object.fromEntries(initialRuntime.packages.filter(p => ['pg', 'turbine-orm', 'drizzle-orm', '@prisma/client', '@prisma/adapter-pg'].includes(p.name))
          .map(p => [p.path, { version: p.version, manifestSha256: p.manifestSha256 }]));
        c.native = { status: 'unavailable', reason: 'No explicit owned loopback PostgreSQL supplied; compilation/import is not native query certification' };
        if (o.pgUrl && tables === Math.min(...o.sizes)) {
          await writeFile(join(runtimeFixture, 'oracle.mjs'), comparisonOracle);
          await writeFile(join(runtimeFixture, 'native.mjs'), nativeSource(arm, tables, format));
          await copyFile(join(runtimeFixture, 'native.mjs'), join(caseDir, 'native.mjs')); await copyFile(join(runtimeFixture, 'oracle.mjs'), join(caseDir, 'oracle.mjs'));
          c.native = await log(process.execPath, ['native.mjs', join(caseDir, 'native-result.json')], runtimeFixture, caseDir, 'native', { CONSUMER_COMPARE_PG_URL: o.pgUrl });
        }
        if (existsSync(join(caseDir, 'native-result.json'))) c.native.result = await readJson(join(caseDir, 'native-result.json'));
        c.runtimeUnchanged = await verifyRuntimePayload(runtimeProject, runtimePayload);
        assert.deepEqual(await payloadTree(join(runtimeFixture, 'out')), c.emittedRuntimePayload, 'Executed deployment payload changed');
        c.status = !bad(c.declarations) && !bad(c.workload) && c.runtime.every(r => !bad(r)) && !bad(c.importGraph) && (!o.pgUrl || tables !== Math.min(...o.sizes) || !bad(c.native)) ? 'measured' : 'failed';
        c.executionComplete = c.runtime.every(r => !bad(r)) && !bad(c.importGraph) && (!o.pgUrl || tables !== Math.min(...o.sizes) || !bad(c.native));
        await save(join(evidenceRoot, 'comparison-report.json'), report);
        console.log(`${arm} ${tables} ${format}: ${c.status}`);
      }
      armReport.runtimeAfterExecution = await verifyRuntimePayload(runtimeProject, runtimePayload);
      armReport.status = armReport.cases.every(c => c.status === 'measured') ? 'measured' : 'failed';
    }
    report.status = o.prepareLocks || Object.values(report.arms).every(a => a.status === 'measured') ? 'measured' : 'failed';
    return report.status === 'measured' ? 0 : 1;
  } catch (error) { report.status = 'failed'; report.failure = String(error); throw error; }
  finally {
    report.finishedAt = new Date().toISOString();
    report.retainedWork = o.workRoot;
    await save(join(evidenceRoot, 'comparison-report.json'), report);
  }
}

export function nativeSource(arm, count, format) {
  return `import assert from 'node:assert/strict';
import pg from 'pg';
import { initialize } from './out/entry.${format === 'esm' ? 'js' : 'cjs'}';
import { query0, query${count - 1} } from './out/workload.${format === 'esm' ? 'js' : 'cjs'}';
import { verify, expectedFor, normalize } from './oracle.mjs';
import { writeFileSync } from 'node:fs';
const Decimal = ${arm === 'prisma' ? "(await import('./out/generated/index.js')).Prisma.Decimal" : 'undefined'};
const endpoint = new URL(process.env.CONSUMER_COMPARE_PG_URL);
const admin = new pg.Client({ connectionString: endpoint.toString() });
const database = 'consumer_compare_' + process.pid;
let client, raw, created = false;
try {
  await admin.connect();
  await admin.query('CREATE DATABASE ' + database); created = true;
  endpoint.pathname = '/' + database; const url = endpoint.toString();
  raw = new pg.Client({ connectionString: url }); await raw.connect();
  // Each command owns a fresh database supplied by its external lifecycle helper.
  // Do not mutate existing relations. CREATE refuses a dirty/unowned database.
  const results = {};
  for (const domain of ['safe', 'precision']) {
  for (let i = 0; i < ${count}; i++) {
    if (domain === 'safe') await raw.query('CREATE TABLE records_' + i + ' (id bigint PRIMARY KEY, parent_id bigint NOT NULL, amount numeric(30,10) NOT NULL, label text NOT NULL, rank integer NOT NULL, active boolean NOT NULL, created_at timestamptz(3) NOT NULL, note text)');
    if (domain === 'precision') await raw.query('TRUNCATE records_' + i);
    for (let j = 0; j < 3; j++) await raw.query('INSERT INTO records_' + i + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [((domain === 'safe' ? 1n : 9007199254740993n) + BigInt(j)).toString(), domain === 'safe' ? '1' : '9007199254740993', domain === 'safe' ? '123.1234567891' : '123456789.0123456789', 'row' + j, j, j < 2, new Date('2024-01-02T03:04:05.006Z'), j === 0 ? null : 'note' + j]);
  }
  if (!client) client = initialize(url);
  const domainExpected = expectedFor('${arm}', domain);
  try {
  for (const query of [query0, query${count - 1}]) {
    const actual = await query(client.db, 1, true); verify(actual, '${arm}', domain, Decimal);
    // Meaningful oracle omission controls: lost row, field, order, value and changed dynamic input.
    for (const mutate of [r => r.full.pop(), r => delete r.full[0].note,
      r => r.full.reverse(), r => r.selected[0].amount = '1', r => r.full[0].children.pop()]) {
      const broken = structuredClone(normalize(actual, Decimal)); mutate(broken);
      assert.throws(() => assert.deepEqual(broken, domainExpected));
    }
    const changed = await query(client.db, 2, true);
    assert.deepEqual(changed.dynamic, [], 'dynamic parameters must affect execution');
    assert.throws(() => assert.deepEqual(normalize(changed, Decimal), domainExpected));
  }
  results[domain] = { status: 'passed', queries: 2, negativeControls: 12 };
  } catch (error) { results[domain] = { status: 'failed', error: String(error) }; }
  }
  const nativeResult = { results, arm: '${arm}', format: '${format}', server: (await raw.query('SHOW server_version')).rows };
  writeFileSync(process.argv[2], JSON.stringify(nativeResult, null, 2));
  assert.equal(results.safe.status, 'passed', 'safe-domain equivalence');
  assert.equal(results.precision.status, 'passed', 'precision-domain equivalence');
  console.log(JSON.stringify({ status: 'passed', arm: '${arm}', format: '${format}', cases: 2, negativeControls: 12, server: (await raw.query('SHOW server_version')).rows }));
} finally {
  try { if (client) await client.close(); } finally {
    try { if (raw) await raw.end(); } finally {
      try { if (created) {
        const remaining = await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [database]);
        assert.deepEqual(remaining.rows, [], 'all owned query connections closed');
        await admin.query('DROP DATABASE ' + database);
      } } finally { await admin.end(); }
    }
  }
}
`;
}
