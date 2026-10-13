/**
 * turbine-orm, Prisma string-literal escapes in `migrate-from-prisma`.
 *
 * The parser reads `"..."` literals out of a schema.prisma: datasource URLs,
 * `@map` / `@@map` names, `@default("...")` values. The escapes are not
 * independent of each other. Resolving `\\` and then `\n` in two separate passes
 * reads the backslash that the first pass produced as the start of the second
 * escape, so the literal `"C:\\new"` (a backslash followed by the letter n) came
 * out as `C:`, a newline, and `ew`. These tests pin one-pass resolution.
 *
 * Run: npx tsx --test src/test/codeql-prisma-unquote.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePrismaSchema } from '../cli/prisma-schema.js';

/** The URL a datasource declares as a literal, parsed from schema TEXT (so `\\` here is two characters). */
function datasourceUrl(literal: string): string | undefined {
  const ast = parsePrismaSchema(`datasource db {\n  provider = "postgresql"\n  url = ${literal}\n}`);
  const url = ast.datasources[0]?.url;
  return url?.kind === 'literal' ? url.value : undefined;
}

describe('Prisma string literals resolve their escapes in one pass', () => {
  it('an escaped backslash followed by n stays a backslash and an n', () => {
    // schema text: "postgres://u:p\\new@h/db"
    assert.equal(datasourceUrl(String.raw`"postgres://u:p\\new@h/db"`), 'postgres://u:p\\new@h/db');
  });

  it('an escaped backslash followed by t stays a backslash and a t', () => {
    // schema text: "C:\\temp"
    assert.equal(datasourceUrl(String.raw`"C:\\temp"`), 'C:\\temp');
  });

  it('an escaped backslash before an escaped quote keeps both meanings', () => {
    // schema text: "a\\\"b"  ->  a, backslash, quote, b
    assert.equal(datasourceUrl(String.raw`"a\\\"b"`), 'a\\"b');
  });

  it('the single escapes still resolve: \\n, \\t and \\"', () => {
    assert.equal(datasourceUrl(String.raw`"a\nb\tc\"d"`), 'a\nb\tc"d');
  });

  it('an escape Prisma does not define is left as written', () => {
    assert.equal(datasourceUrl(String.raw`"a\qb"`), 'a\\qb');
  });

  it('applies to @@map names as well, not only to datasource URLs', () => {
    const ast = parsePrismaSchema(`model A {\n  id Int @id\n  @@map("x\\\\ny")\n}`);
    assert.equal(ast.models[0]?.map, 'x\\ny');
  });
});
