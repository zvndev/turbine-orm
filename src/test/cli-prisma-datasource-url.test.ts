/**
 * turbine-orm - `migrate-from-prisma` connection-string precedence (no DB).
 *
 * The command may fall back to the `datasource` block declared in
 * `schema.prisma`, including its `env("NAME")` indirection. This pins the
 * precedence: `--url` > `DATABASE_URL` > `turbine.config.ts` > datasource.
 *
 * Run: npx tsx --test src/test/cli-prisma-datasource-url.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { resolveConfig } from '../cli/config.js';
import { resolveMigrateFromPrismaUrl } from '../cli/index.js';
import { parsePrismaSchema } from '../cli/prisma-schema.js';

const AST = parsePrismaSchema(
  ['datasource db {', '  provider = "postgresql"', '  url      = env("DATABASE_URL_AUG_4")', '}'].join('\n'),
);

const ENV_WITH_DECLARED = { DATABASE_URL_AUG_4: 'postgres://declared/db' };

describe('resolveMigrateFromPrismaUrl', () => {
  it('honors the datasource env() variable name when nothing else supplies a URL', () => {
    const got = resolveMigrateFromPrismaUrl('', AST, ENV_WITH_DECLARED);
    assert.equal(got.source, 'datasource');
    assert.equal(got.url, 'postgres://declared/db');
    assert.equal(got.datasource?.variable, 'DATABASE_URL_AUG_4');
  });

  it('never lets the declared variable override an explicit --url', () => {
    // resolveConfig has already collapsed --url / DATABASE_URL / config.url.
    const configUrl = resolveConfig({ url: 'postgres://from-config/db' }, { url: 'postgres://from-flag/db' }).url;
    assert.equal(configUrl, 'postgres://from-flag/db');

    const got = resolveMigrateFromPrismaUrl(configUrl, AST, ENV_WITH_DECLARED);
    assert.equal(got.source, 'config');
    assert.equal(got.url, 'postgres://from-flag/db');
  });

  it('prefers DATABASE_URL over the declared variable', () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://from-database-url/db';
    try {
      const configUrl = resolveConfig({}, {}).url;
      assert.equal(configUrl, 'postgres://from-database-url/db');
      const got = resolveMigrateFromPrismaUrl(configUrl, AST, ENV_WITH_DECLARED);
      assert.equal(got.source, 'config');
      assert.equal(got.url, 'postgres://from-database-url/db');
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it('reports the declared-but-unset variable so the error can name it', () => {
    const got = resolveMigrateFromPrismaUrl('', AST, {});
    assert.equal(got.source, 'none');
    assert.equal(got.url, undefined);
    assert.deepEqual(got.missingVariables, ['DATABASE_URL_AUG_4']);
  });
});

describe('no-URL error regression guard (static, the CLI is never spawned in unit tests)', () => {
  it('requireUrl keeps its three suggestions and adds the declared variable names', () => {
    const source = readFileSync(new URL('../cli/index.ts', import.meta.url), 'utf-8');
    // The pre-existing suggestions must survive: the consumer report called the
    // no-URL message good, so it is only extended, never replaced.
    for (const hint of ['No database URL provided.', 'turbine.config.ts', 'DATABASE_URL', '--url']) {
      assert.ok(source.includes(hint), `requireUrl must still mention ${hint}`);
    }
    assert.match(source, /options\.datasourceVars/);
    assert.match(source, /declared by your schema\.prisma datasource/);
    // ...and the command must pass them in, or the hint can never appear.
    assert.match(source, /requireUrl\(config, \{ datasourceVars: resolvedUrl\.missingVariables \}\)/);
  });
});
