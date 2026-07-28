/**
 * turbine-orm, the compiler-checked query-option surface (query/option-surface.ts)
 * and the Prisma-key set that the prisma-compat unknown-option warning is
 * measured against.
 *
 * The tables themselves are enforced by the TYPE CHECKER, not by these tests:
 * `Record<keyof FindManyArgs<Row>, OptionKind>` fails to compile when an option
 * is added to the interface and not classified here, which is the mechanism that
 * makes "stranded by omission" impossible. What is left for runtime is the
 * shape of the data (a table stubbed out during a refactor would still compile
 * as `{}` under a looser type) and the one thing types cannot check at all: that
 * `PRISMA_ARG_KEYS` still describes a real generated Prisma client.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { PRISMA_ARG_KEYS } from '../prisma-compat.js';
import { ALL_OPTION_TABLES, applyNativeOptions, FIND_MANY_OPTIONS, type OptionKind } from '../query/index.js';
import { skipGate } from './helpers.js';

const KINDS: OptionKind[] = ['prisma', 'native', 'nativeAlias', 'internal'];

describe('query option surface, table shape', () => {
  it('every arg interface has a table, and every table is non-empty and well-formed', () => {
    const names = Object.keys(ALL_OPTION_TABLES);
    // One per arg interface in query/types.ts.
    assert.equal(names.length, 13);
    for (const name of names) {
      const table = ALL_OPTION_TABLES[name]!;
      const keys = Object.keys(table);
      assert.ok(keys.length > 0, `${name} table is empty`);
      for (const key of keys) {
        assert.ok(KINDS.includes(table[key]!), `${name}.${key} has invalid kind ${String(table[key])}`);
      }
    }
  });

  it('the option a caller reported stranded is classified, and classified native', () => {
    // Not a tautology: `'prisma'` would mean "hand-translated" and `'internal'`
    // would mean "unreachable from compat", and either would re-strand it.
    assert.equal(FIND_MANY_OPTIONS.forceCustomPlan, 'native');
    assert.equal(FIND_MANY_OPTIONS.warnOnUnlimited, 'native');
    assert.equal(FIND_MANY_OPTIONS.skipGlobalFilters, 'native');
  });

  it('the turbine spellings of Prisma concepts are refused, never copied', () => {
    assert.equal(FIND_MANY_OPTIONS.with, 'nativeAlias');
    assert.equal(FIND_MANY_OPTIONS.limit, 'nativeAlias');
    assert.equal(FIND_MANY_OPTIONS.offset, 'nativeAlias');
  });
});

describe('applyNativeOptions', () => {
  it('copies only native keys, skips undefined values, and leaves everything else alone', () => {
    const dst: Record<string, unknown> = {};
    applyNativeOptions(
      FIND_MANY_OPTIONS,
      {
        forceCustomPlan: true,
        timeout: 5,
        includePii: undefined,
        where: { id: 1 },
        limit: 10,
        somethingElse: 'x',
      },
      dst,
    );
    assert.deepEqual(dst, { forceCustomPlan: true, timeout: 5 });
  });

  it('does not enumerate the table, so an inherited name cannot leak through', () => {
    const dst: Record<string, unknown> = {};
    const src = Object.create({ forceCustomPlan: true }) as Record<string, unknown>;
    src.timeout = 1;
    applyNativeOptions(FIND_MANY_OPTIONS, src, dst);
    assert.deepEqual(dst, { timeout: 1 });
  });
});

// ---------------------------------------------------------------------------
// Prisma-surface drift
// ---------------------------------------------------------------------------

const GENERATED_CLIENT = new URL('../../benchmarks/node_modules/.prisma/client/index.d.ts', import.meta.url).pathname;
const { it: driftIt } = skipGate(!existsSync(GENERATED_CLIENT), 'no generated @prisma/client to compare against');

/** Pull `{ key: ... }` names out of one `export type <Model><Op>Args<...> = { ... }` block. */
function extractArgKeys(dts: string, model: string, op: string): string[] | null {
  const start = dts.indexOf(`export type ${model}${op}Args<`);
  if (start === -1) return null;
  const open = dts.indexOf('= {', start);
  if (open === -1) return null;
  const end = dts.indexOf('\n  }', open);
  if (end === -1) return null;
  const body = dts.slice(open, end);
  const keys = new Set<string>();
  for (const line of body.split('\n')) {
    const m = /^ {4}(_?[A-Za-z][A-Za-z0-9]*)\??:/.exec(line);
    if (m) keys.add(m[1]!);
  }
  return [...keys];
}

const OP_SUFFIX: Record<string, string> = {
  findMany: 'FindMany',
  findFirst: 'FindFirst',
  findFirstOrThrow: 'FindFirstOrThrow',
  findUnique: 'FindUnique',
  findUniqueOrThrow: 'FindUniqueOrThrow',
  create: 'Create',
  createMany: 'CreateMany',
  update: 'Update',
  updateMany: 'UpdateMany',
  delete: 'Delete',
  deleteMany: 'DeleteMany',
  upsert: 'Upsert',
  count: 'Count',
  aggregate: 'Aggregate',
  groupBy: 'GroupBy',
};

describe('PRISMA_ARG_KEYS vs a real generated client', () => {
  driftIt('is a superset of every per-operation key set the generated client declares', () => {
    const dts = readFileSync(GENERATED_CLIENT, 'utf8');
    const missing: string[] = [];
    let compared = 0;
    for (const [op, suffix] of Object.entries(OP_SUFFIX)) {
      const actual = extractArgKeys(dts, 'User', suffix);
      if (!actual) continue;
      compared++;
      const known = new Set(PRISMA_ARG_KEYS[op as keyof typeof PRISMA_ARG_KEYS]);
      for (const key of actual) if (!known.has(key)) missing.push(`${op}.${key}`);
    }
    assert.ok(compared >= 12, `expected to compare most operations, compared ${compared}`);
    assert.deepEqual(
      missing,
      [],
      // A miss here is not a bug in the client, it is this adapter's key set
      // falling behind a Prisma version. Add the key (the set is the UNION
      // across supported majors, so nothing is ever removed).
      `PRISMA_ARG_KEYS is missing keys the generated client declares: ${missing.join(', ')}`,
    );
  });
});
