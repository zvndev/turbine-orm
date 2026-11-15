#!/usr/bin/env node
// Collect in a fresh owned directory, then attach inspector maps to the exact
// raw process/isolate record. Never repair or annotate an existing collection.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (args[0] !== '--directory' || !args[1] || separator !== 2 || !args[3]) {
  console.error('Usage: node tooling/coverage-regressions/collect.mjs --directory <raw-dir> -- <command> [args...]');
  process.exit(1);
}
const directory = resolve(args[1]);
mkdirSync(directory, { recursive: true });
const staging = mkdtempSync(resolve(directory, '.capture-'));
const preload = fileURLToPath(new URL('./capture.cjs', import.meta.url));
const child = spawn(args[3], args.slice(4), {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_V8_COVERAGE: staging,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`,
    TURBINE_COVERAGE_CAPTURE_DIRECTORY: staging,
    TURBINE_COVERAGE_SOURCE_ROOT: process.env.TURBINE_COVERAGE_SOURCE_ROOT ?? resolve('src'),
  },
});
let launchError;
child.on('error', (error) => { launchError = error; });
const interrupt = () => child.kill('SIGINT');
const terminate = () => child.kill('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
const [code, signal] = await new Promise((done) => child.on('close', (...result) => done(result)));
process.off('SIGINT', interrupt);
process.off('SIGTERM', terminate);
try {
  if (launchError) throw launchError;
  const files = readdirSync(staging).filter((name) => /^coverage-\d+-\d+-\d+\.json$/.test(name));
  if (!files.length) throw new Error('no raw V8 coverage was collected');
  for (const file of files) {
    const [, pid, , thread] = /^coverage-(\d+)-(\d+)-(\d+)\.json$/.exec(file);
    const raw = JSON.parse(readFileSync(resolve(staging, file), 'utf8'));
    const mapsPath = resolve(staging, `maps-${pid}-${thread}.json`);
    if (!existsSync(mapsPath) && !existsSync(resolve(staging, `owner-${pid}-${thread}`))) {
      // Some subprocess contracts intentionally clear NODE_OPTIONS. Retain
      // their native coverage and explicit absence of attribution. Unique URLs
      // still have their own native cache; the reporter rejects any included
      // collision without exact maps. A started but incomplete capture below
      // remains fatal rather than being mistaken for an unpreloaded process.
      raw['turbine-capture-status'] = 'preload-not-run';
      writeFileSync(resolve(directory, file), JSON.stringify(raw), { flag: 'wx' });
      continue;
    }
    const maps = JSON.parse(readFileSync(mapsPath, 'utf8'));
    if (maps.version !== 1 || maps.pid !== Number(pid) || maps.threadId !== Number(thread)
      || maps.errors.length) {
      throw new Error(`invalid capture for ${file}`);
    }
    raw['turbine-script-maps'] = { version: 1, scripts: maps.scripts };
    writeFileSync(resolve(directory, file), JSON.stringify(raw), { flag: 'wx' });
  }
  rmSync(staging, { recursive: true });
} catch (error) {
  console.error(`[coverage] collection attribution failed: ${error.message}. Evidence retained in ${staging}`);
  process.exitCode = 1;
}
if (signal) {
  console.error(`[coverage] collection child terminated by ${signal}`);
  process.exitCode = 1;
} else if (code) {
  process.exitCode = code;
}
