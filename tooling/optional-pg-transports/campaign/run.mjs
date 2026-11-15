#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveIdentity, command, installedPayload } from '../harness.mjs';
import { startService } from '../native-service.mjs';
import { runWithShutdown } from '../run.mjs';
import { base, hash, options, pins, spec, treeIdentity, unsupported } from './contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
export async function main(argv = process.argv.slice(2)) {
  const args = options(argv);
  const out = resolve(args.out);
  mkdirSync(out, { recursive: true });
  assert.equal(existsSync(join(out, 'report.json')), false, 'Use a fresh output directory; never overwrite evidence');
  const report = { schemaVersion: 1, task: 'pg-transport-benchmark', preparedBase: base,
    acceptance: 'NOT ACCEPTED COMPARATIVE TIMING; serial measurement of the tested artifact required',
    mode: args.mode, spec, unsupported, commands: [], services: [], formats: ['esm', 'cjs'],
    runtime: { version: process.version, path: process.execPath, sha256: hash(readFileSync(process.execPath)), versions: process.versions },
    source: { path: repo, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
      branch: execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim(),
      status: execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }),
      production: treeIdentity(join(repo, 'src')), tooling: treeIdentity(join(repo, 'tooling/optional-pg-transports')),
      nativeHelpers: treeIdentity(join(repo, 'tooling/native-consumer-contracts')),
      example: treeIdentity(join(repo, 'examples/notification-live-query')) },
  };
  let root;
  const previousTmp = process.env.TMPDIR;
  await runWithShutdown(report, join(out, 'report.json'), async (scope) => {
    assert.equal(process.version, 'v24.10.0', 'Exact baseline Node 24.10.0 required; no implicit upgrade');
    assert.ok(process.env.PG_PREFIX, 'Explicit PG_PREFIX required; no ambient service or remote endpoint');
    assert.equal(process.env.TURBINE_OPTIONAL_PG_SERVICE_URL, undefined, 'Owned native cluster only');
    const archive = archiveIdentity(resolve(args.artifact), args.sha256);
    for (const condition of ['import', 'require']) assert.ok(archive.manifest.exports?.['./core']?.[condition]?.default, 'Final archive must export actual core');
    report.artifact = { path: archive.tarball, sha256: archive.sha256, version: archive.manifest.version, scope: 'actual installed archive, no local dist/source timings' };
    const prefix = resolve(process.env.PG_PREFIX);
    report.nativeBinaries = Object.fromEntries(['postgres', 'initdb'].map((name) => {
      const path = join(prefix, 'bin', name); return [name, { path, sha256: hash(readFileSync(path)) }];
    }));
    const scratch = resolve(args.scratch);
    mkdirSync(scratch, { recursive: true });
    root = mkdtempSync(join(scratch, 'r-'));
    // The existing supervisor creates its ownership journals via os.tmpdir().
    // Keep service journals together with the disposable consumer data.
    process.env.TMPDIR = root;
    report.root = root;
    const consumer = join(root, 'consumer'), reference = join(root, 'reference'), serviceRoot = join(root, 'pg');
    for (const path of [consumer, reference, serviceRoot]) mkdirSync(path);
    const npmCli = realpathSync(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim());
    report.npm = { path: npmCli, sha256: hash(readFileSync(npmCli)) };
    const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: root, TZ: 'UTC',
      npm_config_cache: join(scratch, 'npm-cache'), TMPDIR: root, PRISMA_SKIP_POSTINSTALL_GENERATE: '1',
      LD_LIBRARY_PATH: [join(prefix, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
    report.environment = { PATH: env.PATH, HOME: env.HOME, TZ: env.TZ, TMPDIR: env.TMPDIR, npm_config_cache: env.npm_config_cache, LD_LIBRARY_PATH: env.LD_LIBRARY_PATH };
    const run = (binary, values, customEnv = env, timeoutMs = 180000) => command(report, consumer, binary, values, customEnv, { scope, timeoutMs });
    await run('tar', ['-xzf', archive.tarball, '-C', reference]);
    const manifest = { private: true, type: 'module', dependencies: { 'turbine-orm': `file:${archive.tarball}`, ...pins } };
    writeFileSync(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2));
    if (args.lock) cpSync(resolve(args.lock), join(consumer, 'package-lock.json'));
    else await run(process.execPath, [npmCli, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);
    cpSync(join(consumer, 'package-lock.json'), join(out, 'package-lock.json'));
    report.installLock = { path: join(out, 'package-lock.json'), sha256: hash(readFileSync(join(out, 'package-lock.json'))) };
    await run(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    const installed = join(consumer, 'node_modules/turbine-orm');
    report.payloadHashes = installedPayload(join(reference, 'package'), installed);
    report.dependencies = Object.fromEntries(Object.entries(pins).map(([name, pin]) => {
      const path = join(consumer, 'node_modules', name);
      const manifest = JSON.parse(readFileSync(join(path, 'package.json')));
      assert.equal(manifest.version, pin.startsWith('npm:') ? pin.slice(pin.lastIndexOf('@') + 1) : pin, `Exact ${name} pin`);
      return [name, { version: manifest.version, path, ...treeIdentity(path) }];
    }));
    for (const file of ['consumer.mjs', 'contract.mjs', 'typed.mts', 'omissions.mjs']) cpSync(join(here, file), join(consumer, file));
    for (const file of ['native-bridge.mjs', 'native-lifecycle.mjs']) cpSync(join(repo, 'src/test/fixtures/neon-http', file), join(consumer, file));
    cpSync(join(repo, 'examples/notification-live-query/application.ts'), join(consumer, 'application.mts'));
    cpSync(join(repo, 'tooling/optional-pg-transports/smoke.mjs'), join(consumer, 'smoke.mjs'));
    cpSync(join(repo, 'tooling/optional-pg-transports/native-consumer.mjs'), join(consumer, 'native.mjs'));
    for (const file of ['native-contract.mjs', 'native-consumer.mjs']) cpSync(join(repo, 'src/test/fixtures/neon-http', file), join(consumer, file));
    writeFileSync(join(consumer, 'entry.mjs'), 'export const load = (name) => import(name);\n');
    // Existing package smoke owns omission and both module formats. Dependencies
    // are physically renamed, restored, and the exact archive is rechecked below.
    const { renameSync } = await import('node:fs');
    for (const [dependency, phase] of [['@neondatabase/serverless', 'missing-peer'], ['pg', 'pg-free']]) {
      const original = join(consumer, 'node_modules', dependency), hidden = join(root, 'omitted');
      renameSync(original, hidden);
      try { for (const format of report.formats) await run(process.execPath, ['smoke.mjs', format, phase]); }
      finally { renameSync(hidden, original); }
    }
    const pgPath = join(consumer, 'node_modules/pg'), neonPath = join(consumer, 'node_modules/@neondatabase/serverless');
    renameSync(pgPath, join(root, 'omitted-pg')); renameSync(neonPath, join(root, 'omitted-neon'));
    try { for (const format of report.formats) await run(process.execPath, ['omissions.mjs', format]); }
    finally { renameSync(join(root, 'omitted-pg'), pgPath); renameSync(join(root, 'omitted-neon'), neonPath); }
    report.omissionControls = { neonPeer: true, pgRuntime: true, scope: 'physical omission, actual installed ESM and CJS; mandatory install pg still disclosed' };
    const tsc = join(consumer, 'node_modules/typescript/bin/tsc');
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false,
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'], outDir: 'compiled' }, files: ['typed.mts', 'application.mts'] }));
    await run(process.execPath, [tsc, '-p', 'tsconfig.json']);
    report.typedComposition = { compiled: true, sourceSha256: hash(readFileSync(join(consumer, 'typed.mts'))), applicationSha256: hash(readFileSync(join(consumer, 'application.mts'))) };
    writeFileSync(join(consumer, 'schema.prisma'), `generator client {
  provider = "prisma-client-js"
  output = "./generated/prisma"
  engineType = "client"
}
datasource db {
  provider = "postgresql"
}
model TransportRow {
  id Int @id
  tenantId Int @map("tenant_id")
  title String
  secret String
  @@map("transport_rows")
}
`);
    await run(process.execPath, [join(consumer, 'node_modules/prisma/build/index.js'), 'generate', '--schema', 'schema.prisma']);
    report.generatedPrisma = treeIdentity(join(consumer, 'generated/prisma'));
    cpSync(join(consumer, 'schema.prisma'), join(out, 'schema.prisma'));
    report.executedFixtures = treeIdentity(consumer).files;
    // No service is started before dependency/type/export admission succeeds.
    console.log(`OWNED SERVICE ROOT ${serviceRoot}; PostgreSQL/WS ports ephemeral loopback, identities retained in report`);
    const require = createRequire(join(consumer, 'package.json'));
    const service = await startService({ root: serviceRoot, env, pg: require('pg'), WebSocketServer: require('ws').WebSocketServer, report, scope });
    report.endpoints = service;
    if (process.env.OPTIONAL_PG_CONTROL_SIGNAL) {
      assert.equal(args.mode, 'preflight', 'Signal controls cannot collect samples');
      const signal = process.env.OPTIONAL_PG_CONTROL_SIGNAL;
      assert.ok(['SIGINT', 'SIGTERM'].includes(signal), 'Explicit SIGINT or SIGTERM control only');
      report.injectedControl = { signal, afterOwnedServicesReady: true };
      const delivered = new Promise((resolve) => process.once(signal, resolve));
      process.kill(process.pid, signal); await delivered; scope.assertOpen();
    }
    const nativeEnv = { ...env, OPTIONAL_PG_URL: service.url, OPTIONAL_PG_PROXY: service.proxy };
    for (const format of report.formats) await run(process.execPath, ['native.mjs', format], nativeEnv, 30000);
    report.installedEsmCjsNative = true;
    report.existingHttpNativeContracts = [];
    for (const format of report.formats) {
      const path = join(out, `http-${format}.json`);
      await run(process.execPath, ['native-consumer.mjs', format], { ...nativeEnv, NEON_HTTP_CONSUMER_ROOT: consumer, NEON_HTTP_NATIVE_URL: service.url, NEON_HTTP_NATIVE_REPORT: path }, 30000);
      report.existingHttpNativeContracts.push({ format, path, sha256: hash(readFileSync(path)) });
    }
    const childOut = join(out, 'workload.json');
    await run(process.execPath, ['consumer.mjs', args.mode, String(args.rounds), String(args.warmup), childOut], nativeEnv, 180000);
    report.workload = JSON.parse(readFileSync(childOut));
    assert.equal(report.workload.success, true);
    assert.equal(report.workload.cleanup.complete, true);
    report.payloadHashes = installedPayload(join(reference, 'package'), installed);
    archiveIdentity(archive.tarball, archive.sha256);
    report.payloadUnchanged = true;
  }, async (errors) => {
    if (root) rmSync(root, { recursive: true, force: true });
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    report.cleanup = { rootRemoved: root ? !existsSync(root) : true, errors };
    if (!report.failure) {
      assert.equal(report.cleanup.rootRemoved, true);
      for (const service of report.services) assert.equal(service.auditComplete, true, 'Every owned service needs a successful independent audit');
    }
  });
  console.log(`Prepared exact installed transport campaign: ${join(out, 'report.json')}`);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.stack); process.exitCode ||= 1; }
}
