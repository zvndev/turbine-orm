#!/usr/bin/env node
/** Install the exact pretested archive. Never stages or rewrites a package. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { archiveIdentity, command, files, installedPayload, prerequisites, sha256, validateReport } from '../tooling/optional-pg-transports/harness.mjs';
import { startService } from '../tooling/optional-pg-transports/native-service.mjs';
import { runWithShutdown } from '../tooling/optional-pg-transports/run.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function checkOptionalPg(argv = process.argv.slice(2)) {
  const tarballArg = argv.shift();
  const options = {};
  while (argv.length) {
    const key = argv.shift();
    assert.ok(['--sha256', '--report', '--native', '--measure'].includes(key), `Unknown option ${key}`);
    options[key] = ['--native', '--measure'].includes(key) ? true : argv.shift();
    assert.ok(options[key], `Missing value for ${key}`);
  }
  const report = { scope: 'branch tooling against exact installed archive; no hosted/provider certification', runtime: process.version, commands: [], services: [], formats: ['esm', 'cjs'], native: { requested: Boolean(options['--native']), verified: false }, httpNativeVerified: false };
  const reportPath = options['--report'] ? resolve(options['--report']) : join(mkdtempSync(join(tmpdir(), 'optional-pg-transports-')), 'report.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  let root;
  await runWithShutdown(report, reportPath, async (scope) => {
    const identity = archiveIdentity(tarballArg && resolve(tarballArg), options['--sha256'] ?? process.env.TURBINE_OPTIONAL_PG_SHA256);
    report.archive = { tarball: identity.tarball, sha256: identity.sha256, version: identity.manifest.version };
    prerequisites(options['--native'], process.env);
    root = mkdtempSync(join(tmpdir(), 'turbine-optional-gate-'));
    report.root = root;
    const reference = join(root, 'reference'), consumer = join(root, 'consumer');
    mkdirSync(reference); mkdirSync(consumer);
    execFileSync('tar', ['-xzf', identity.tarball, '-C', reference]);
    const installed = join(consumer, 'node_modules/turbine-orm');
    const run = (binary, args, env) => command(report, consumer, binary, args, env, { scope });
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await run('npm', ['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', identity.tarball, '@types/node@22.20.4']);
    report.payloadHashes = installedPayload(join(reference, 'package'), installed);
    assert.equal(existsSync(join(consumer, 'node_modules/@types/pg')), false, '@types/pg must not be required');
    assert.equal(existsSync(join(consumer, 'node_modules/@neondatabase/serverless')), false, 'Neon omission must be real');
    cpSync(join(repo, 'tooling/optional-pg-transports/smoke.mjs'), join(consumer, 'smoke.mjs'));
    for (const format of report.formats) await run(process.execPath, ['smoke.mjs', format, 'missing-peer']);
    const types = `import {TurbineClient} from 'turbine-orm';
import {turbineNeonWs,withNeonWs,type NeonWsOptions} from 'turbine-orm/neon-ws';
import {turbineNeonHttp,type NeonHttpSql} from 'turbine-orm/neon-http';
import {liveQuery,type LiveQuery} from 'turbine-orm/live-query';
import {createNotificationHub} from 'turbine-orm/notification-hub';
const schema={tables:{},enums:{}};
const options:NeonWsOptions={sessionMode:'persistent',lifetime:'persistent'};
function typeOnly(sql:NeonHttpSql) {
const bound:Promise<TurbineClient>=turbineNeonWs({connection:{connectionString:'postgresql://unused'}},schema,options);
const result:Promise<number>=withNeonWs({connection:{connectionString:'postgresql://unused'}},schema,{sessionMode:'persistent'},async db=>{await db.rawQuery('SELECT 1');return 1;});
const http=turbineNeonHttp(sql,schema); void http; void bound; void result;
}
void typeOnly; void createNotificationHub;
const snapshot:LiveQuery<{id:number}>=liveQuery({query:()=>({id:1}),subscribe:()=>({unsubscribe(){}})});
// @ts-expect-error snapshot preserves number rather than any
const invalid:LiveQuery<{id:string}>=snapshot;
void invalid;
`;
    for (const extension of ['mts', 'cts']) {
      writeFileSync(join(consumer, `types.${extension}`), types);
      cpSync(join(repo, 'src/test/fixtures/notification-hub', `consumer.${extension}`), join(consumer, `hub.${extension}`));
      cpSync(join(repo, 'src/test/fixtures/live-query/consumer.ts.txt'), join(consumer, `live.${extension}`));
    }
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false, noEmit: true, target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023', 'DOM'], types: ['node'] }, include: ['*.mts', '*.cts'] }));
    const tsc = join(repo, 'node_modules/typescript/bin/tsc');
    await run(process.execPath, [tsc, '-p', 'tsconfig.json']);
    const driverFreeTypes = `import {liveQuery,type LiveQuery} from 'turbine-orm/live-query';
import {createNotificationHub} from 'turbine-orm/notification-hub';
const live:LiveQuery<{id:number}>=liveQuery({query:()=>({id:1}),subscribe:()=>({unsubscribe(){}})});
void live; void createNotificationHub;`;
    for (const extension of ['mts', 'cts']) writeFileSync(join(consumer, `free.${extension}`), driverFreeTypes);
    mkdirSync(join(consumer, 'empty-types'));
    writeFileSync(join(consumer, 'tsconfig-driver-free.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false, noEmit: true, target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023', 'DOM'], types: [], typeRoots: ['./empty-types'] }, files: ['hub.mts', 'hub.cts', 'free.mts', 'free.cts'] }));
    await run(process.execPath, [tsc, '-p', 'tsconfig-driver-free.json']);
    // Physical driver omission is a negative fixture only; package payload stays untouched.
    const pg = join(consumer, 'node_modules/pg');
    renameSync(pg, join(root, 'pg-omitted'));
    try { for (const format of report.formats) await run(process.execPath, ['smoke.mjs', format, 'pg-free']); }
    finally { renameSync(join(root, 'pg-omitted'), pg); }
    report.pgFree = ['neon-http', 'live-query', 'notification-hub'];
    report.pgRetained = ['main', 'neon-ws'];
    await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '@neondatabase/serverless@1.2.0', 'ws@8.18.3']);
    for (const format of report.formats) await run(process.execPath, ['smoke.mjs', format, 'installed-peer']);
    for (const extension of ['mts', 'cts']) writeFileSync(join(consumer, `supplied.${extension}`), `import {Pool,Client} from '@neondatabase/serverless';
import {turbineNeonWs} from 'turbine-orm/neon-ws';
const schema={tables:{},enums:{}}; const options={sessionMode:'persistent',lifetime:'persistent'} as const;
function typeOnly(){void turbineNeonWs({pool:new Pool()},schema,options);void turbineNeonWs({client:new Client()},schema,options);} void typeOnly;
`);
    assert.equal(existsSync(join(consumer, 'node_modules/@types/pg')), false);
    await run(process.execPath, [tsc, '-p', 'tsconfig.json']);
    // Preserve a complete physical install inventory separately from library bundle size.
    const modules = join(consumer, 'node_modules');
    const inventory = [];
    function inventoryDir(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === '.bin') continue;
        const path = join(directory, entry.name);
        if (entry.name.startsWith('@')) { inventoryDir(path); continue; }
        if (!existsSync(join(path, 'package.json'))) continue;
        const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
        const payload = files(path).filter((file) => !file.startsWith('node_modules/'));
        inventory.push({ name: pkg.name, version: pkg.version, dependencies: pkg.dependencies ?? {}, optionalDependencies: pkg.optionalDependencies ?? {}, peerDependencies: pkg.peerDependencies ?? {}, path: path.slice(modules.length + 1), files: payload.length, bytes: payload.reduce((sum, file) => sum + readFileSync(join(path, file)).length, 0), scope: pkg.name === '@types/node' || pkg.name === 'undici-types' ? 'type fixture' : 'runtime install' });
        if (existsSync(join(path, 'node_modules'))) inventoryDir(join(path, 'node_modules'));
      }
    }
    inventoryDir(modules);
    const lock = readFileSync(join(consumer, 'package-lock.json'));
    writeFileSync(`${reportPath}.package-lock.json`, lock, { mode: 0o600 });
    report.installLock = { path: `${reportPath}.package-lock.json`, sha256: sha256(lock) };
    report.installGraphScope = 'Actual complete consumer install with mandatory pg, Neon and ws relay; uncompressed physical package payload, excluding type fixtures. Separate from driver-externalized library bundle bytes.';
    report.installGraph = inventory;
    report.runtimeInstallBytes = inventory.filter((pkg) => pkg.scope === 'runtime install').reduce((sum, pkg) => sum + pkg.bytes, 0);
    if (options['--measure']) report.measurements = JSON.parse(await run(process.execPath, [join(repo, 'tooling/optional-pg-transports/measure.mjs'), installed, reportPath]));
    if (options['--native']) {
      const require = createRequire(join(consumer, 'package.json'));
      const nativeRoot = join(root, 'native'); mkdirSync(nativeRoot);
      const nativeEnv = { ...process.env, ...(process.env.PG_PREFIX ? { LD_LIBRARY_PATH: [join(process.env.PG_PREFIX, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } : {}) };
      const service = await startService({ root: nativeRoot, env: nativeEnv, pg: require('pg'), WebSocketServer: require('ws').WebSocketServer, report, scope });
      cpSync(join(repo, 'tooling/optional-pg-transports/native-consumer.mjs'), join(consumer, 'native.mjs'));
      report.native.results = [];
      for (const format of report.formats) {
        const stdout = await run(process.execPath, ['native.mjs', format], { ...process.env, OPTIONAL_PG_URL: service.url, OPTIONAL_PG_PROXY: service.proxy });
        report.native.results.push(JSON.parse(stdout.trim().split('\n').at(-1)));
      }
      Object.assign(report.native, { verified: true, formats: report.formats, actualDriver: '@neondatabase/serverless@1.2.0' });
    }
    report.payloadHashes = installedPayload(join(reference, 'package'), installed);
    assert.equal(archiveIdentity(identity.tarball, identity.sha256).sha256, identity.sha256);
    report.payloadUnchanged = true;
  }, async (cleanupErrors) => {
    if (root) { try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error.stack); } }
    report.cleanup = { consumerRemoved: Boolean(root) && !existsSync(join(root, 'consumer')), referenceRemoved: Boolean(root) && !existsSync(join(root, 'reference')), rootRemoved: Boolean(root) && !existsSync(root), errors: cleanupErrors };
    if (!report.failure && !report.signal && !cleanupErrors.length) validateReport(report);
  });
  console.log(`check-optional-pg-transports: exact archive ${report.archive.sha256}; ESM/CJS strict/no @types/pg; native WS ${report.native.verified ? 'verified locally' : 'not requested'}; report ${reportPath}`);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await checkOptionalPg(); } catch (error) { console.error(error.stack); process.exitCode ||= 1; }
}
