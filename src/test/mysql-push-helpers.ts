/** Isolated packages containing the unchanged production dispatcher under test. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Connection, createConnection } from 'mysql2/promise';
import type { SchemaDef } from '../schema-builder.js';

export const pushRepo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const pushUrl = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';

export function pushRun(command: string, args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, DATABASE_URL: '', NODE_OPTIONS: '', NO_COLOR: '1', ...extra },
    maxBuffer: 20 * 1024 * 1024,
  });
  return { code: r.status, signal: r.signal, output: `${r.stdout}\n${r.stderr}\n${r.error ?? ''}` };
}
export function pushChecked(command: string, args: string[], cwd: string) {
  const r = pushRun(command, args, cwd);
  assert.equal(r.code, 0, r.output);
  return r.output;
}
export function stageMysqlPush(): string {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-push-stage-'));
  try {
    for (const name of ['src', 'types']) cpSync(join(pushRepo, name), join(dir, name), { recursive: true });
    mkdirSync(join(dir, 'scripts'));
    for (const name of [
      'package.json',
      'README.md',
      'LICENSE',
      'tsconfig.json',
      'tsconfig.cjs.json',
      'scripts/finish-cjs-build.mjs',
    ])
      copyFileSync(join(pushRepo, name), join(dir, name));
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const key of ['prepare', 'prepack', 'postpack']) delete manifest.scripts[key];
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    symlinkSync(join(pushRepo, 'node_modules'), join(dir, 'node_modules'), 'dir');
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function pushFixture(
  body: (f: {
    connection: Connection;
    url: string;
    database: string;
    dir: string;
    migrations: string;
    query: (sql: string, values?: (string | number | null)[]) => Promise<Record<string, unknown>[]>;
    schema: (schema: SchemaDef) => void;
  }) => Promise<void>,
  parent?: string,
) {
  const endpoint = new URL(pushUrl);
  const connection = await createConnection({
    host: endpoint.hostname,
    port: Number(endpoint.port || 3306),
    user: decodeURIComponent(endpoint.username),
    password: decodeURIComponent(endpoint.password),
  });
  const database = `turbine_push_${randomBytes(8).toString('hex')}`;
  const dir = mkdtempSync(join(parent ?? tmpdir(), 'turbine-push-project-'));
  try {
    await connection.query(`CREATE DATABASE \`${database}\``);
    await connection.query(`USE \`${database}\``);
    endpoint.pathname = `/${database}`;
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(dir, 'turbine.config.mjs'),
      `export default {engine:'mysql',url:${JSON.stringify(endpoint.href)},schemaFile:'./schema.mjs'};`,
    );
    await body({
      connection,
      url: endpoint.href,
      database,
      dir,
      migrations: join(dir, 'turbine/migrations'),
      query: async (sql, values) =>
        (values ? (await connection.execute(sql, values))[0] : (await connection.query(sql))[0]) as Record<
          string,
          unknown
        >[],
      schema: (schema) => writeFileSync(join(dir, 'schema.mjs'), `export default ${JSON.stringify(schema)};`),
    });
  } finally {
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
    } finally {
      await connection.end();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
