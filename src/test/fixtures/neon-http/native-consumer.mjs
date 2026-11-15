import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { nativeContract } from './native-contract.mjs';

const require = createRequire(pathToFileURL(`${process.env.NEON_HTTP_CONSUMER_ROOT}/package.json`));
const mode = process.argv[2];
const { load: esm } = await import(pathToFileURL(`${process.env.NEON_HTTP_CONSUMER_ROOT}/entry.mjs`).href);
const load = async (name) => (mode === 'cjs' ? require(name) : esm(name));
const { turbineNeonHttp } = await load('turbine-orm/neon-http');
const { neon, neonConfig } = await load('@neondatabase/serverless');
const pg = require('pg');
const report = await nativeContract({
  turbineNeonHttp,
  neon,
  neonConfig,
  pg,
  scope: `actual installed ${mode}`,
  test: async (name, fn) => {
    await fn();
    console.log(`ok ${name}`);
  },
});
console.log(
  JSON.stringify({ mode, cases: report.cases.length, requests: report.bridge.requests.length, passed: true }),
);
