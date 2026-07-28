/**
 * turbine-orm - Prisma schema fingerprint + the stale-map warning it drives.
 *
 * Two claims are under test, and they fail in opposite directions:
 *
 *  1. The fingerprint MOVES on every real edit. A missed change is the whole
 *     failure this feature exists to end, so the edits below are the smallest
 *     ones that still change meaning (one character of a field name, a `?`, a
 *     `@@unique` name), not obviously-different files.
 *  2. The fingerprint HOLDS across differences a checkout can introduce on its
 *     own. A warning that fires on every Windows clone is a warning people turn
 *     off, and then claim 1 is worth nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generatePrismaMap } from '../generate.js';
import { fingerprintPrismaSchema } from '../prisma-schema-fingerprint.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';
import type { PrismaCompatMap } from '../schema.js';

const SCHEMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
  posts Post[]

  @@unique([email, name], name: "email_name")
}

model Post {
  id       Int  @id @default(autoincrement())
  authorId Int
  author   User @relation(fields: [authorId], references: [id])
}
`;

describe('fingerprintPrismaSchema', () => {
  it('is stable for identical input', () => {
    assert.equal(fingerprintPrismaSchema(SCHEMA), fingerprintPrismaSchema(SCHEMA));
  });

  it('carries a version prefix so a future normalization change is recognizable', () => {
    assert.match(fingerprintPrismaSchema(SCHEMA), /^v1:[0-9a-f]{16}$/);
  });

  for (const [what, edited] of [
    ['a renamed field', SCHEMA.replace('name  String?', 'title String?')],
    ['a field made nullable', SCHEMA.replace('email String  @unique', 'email String? @unique')],
    ['a renamed compound-unique selector', SCHEMA.replace('name: "email_name"', 'name: "by_email"')],
    ['a new model', `${SCHEMA}\nmodel Comment {\n  id Int @id\n}\n`],
    ['a removed model', SCHEMA.slice(0, SCHEMA.indexOf('model Post'))],
    ['an edited comment', SCHEMA.replace('model User {', '// the account\nmodel User {')],
  ] as const) {
    it(`changes on ${what}`, () => {
      assert.notEqual(fingerprintPrismaSchema(edited), fingerprintPrismaSchema(SCHEMA), what);
    });
  }

  for (const [what, same] of [
    ['CRLF line endings', SCHEMA.replace(/\n/g, '\r\n')],
    ['lone CR line endings', SCHEMA.replace(/\n/g, '\r')],
    ['a leading BOM', `\uFEFF${SCHEMA}`],
    ['a missing final newline', SCHEMA.trimEnd()],
    ['extra blank lines at EOF', `${SCHEMA}\n\n`],
    ['spaces after the final newline', `${SCHEMA}   `],
    ['tabs and blank lines after the final newline', `${SCHEMA}\n\t \n`],
  ] as const) {
    it(`holds across ${what}`, () => {
      assert.equal(fingerprintPrismaSchema(same), fingerprintPrismaSchema(SCHEMA), what);
    });
  }

  // The end-of-file rule above is NOT a per-line one, and the difference is easy
  // to misread from the code (`/\s+$/` anchors to end of string, not end of
  // line). Nothing in a checkout puts trailing whitespace on an individual line,
  // so it is an edit, and it is hashed. These pin the boundary so a future
  // "tidy-up" of the normalizer cannot quietly widen it.
  for (const [what, edited] of [
    ['trailing spaces on one line', SCHEMA.replace('model User {', 'model User {   ')],
    ['a trailing tab on one line', SCHEMA.replace('model User {', 'model User {\t')],
    ['trailing spaces on every line', SCHEMA.replace(/\n/g, '  \n')],
  ] as const) {
    it(`counts ${what} as a change (end-of-FILE rule is not per-line)`, () => {
      assert.notEqual(fingerprintPrismaSchema(edited), fingerprintPrismaSchema(SCHEMA), what);
    });
  }
});

const MAP: PrismaCompatMap = {
  models: {
    User: {
      table: 'users',
      accessor: 'users',
      fields: { id: 'id', email: 'email' },
      relations: {},
      compoundUniques: {},
    },
  },
  enums: {},
};

describe('generatePrismaMap provenance', () => {
  it('omits `source` entirely when the map carries none', () => {
    assert.ok(!generatePrismaMap(MAP, { noTimestamp: true }).includes('source:'));
  });

  it('emits the path and hash so the runtime can compare them', () => {
    const out = generatePrismaMap(
      { ...MAP, source: { path: 'prisma/schema.prisma', hash: fingerprintPrismaSchema(SCHEMA) } },
      { noTimestamp: true },
    );
    assert.ok(out.includes(`source: { path: 'prisma/schema.prisma', hash: '${fingerprintPrismaSchema(SCHEMA)}' }`));
  });

  it('escapes a quote in the path rather than emitting a broken module', () => {
    const out = generatePrismaMap(
      { ...MAP, source: { path: "od'd/schema.prisma", hash: 'v1:0000000000000000' } },
      { noTimestamp: true },
    );
    assert.ok(out.includes("path: 'od\\'d/schema.prisma'"));
  });
});

/**
 * The warning itself. It is async, unawaited and swallows everything, so the
 * assertions are on the two observable effects: whether a line is printed, and
 * whether the once-registry recorded the path.
 */
describe('stale prisma-map warning', () => {
  const withEnv = async (nodeEnv: string | undefined, fn: () => Promise<void>): Promise<void> => {
    const prev = process.env.NODE_ENV;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  };

  /**
   * Build a compat client over a stub, capture anything it warns, and WAIT ON A
   * DEADLINE rather than a fixed number of event-loop turns.
   *
   * The check is an unawaited `import('node:fs/promises')` plus a real file
   * read, so the number of turns it needs is a property of the machine, not of
   * this test. A fixed budget (20 `setImmediate`s) passed on every local run
   * and failed on a loaded CI runner, which is a flake in the direction that
   * wastes the most time: it reports a defect where there is none.
   *
   * A case that EXPECTS a warning polls until the line appears, so it is bounded
   * by the read, not by a guess. A case that expects none has nothing to poll
   * for and pays a fixed, deliberately generous settle instead; that is the safe
   * direction, since the only thing a too-short wait can do there is miss a
   * straggler, and the path filter below already keeps another case's straggler
   * out of this one's window.
   */
  const run = async (source: PrismaCompatMap['source'], expect: 'warning' | 'silence'): Promise<string[]> => {
    resetWarnOnce(WARN_NS.stalePrismaMap);
    const { createPrismaCompatClient } = await import('../prisma-compat.js');
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...a: unknown[]) => {
      warned.push(a.join(' '));
    };
    try {
      const stub = {
        schema: { tables: { users: { name: 'users', columns: [], primaryKey: ['id'], relations: {} } } },
        table: () => ({}),
      };
      createPrismaCompatClient(stub as never, { ...MAP, source });
      const mine = () => warned.filter((w) => w.includes('prisma-map') && (source ? w.includes(source.path) : true));
      const deadline = Date.now() + (expect === 'warning' ? 10_000 : 1_000);
      while (Date.now() < deadline) {
        if (expect === 'warning' && mine().length) break;
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      console.warn = original;
    }
    return warned.filter((w) => w.includes('prisma-map') && (source ? w.includes(source.path) : true));
  };

  // Distinct fixture paths per case, and each assertion filters on its OWN
  // path. The read is async and unawaited by design, so under full-suite load a
  // straggler from one case can land inside the next case's capture window;
  // sharing one path made that cross-talk indistinguishable from a real warning.
  const realPath = 'src/test/fixtures/fingerprint-schema.prisma';
  const stalePath = 'src/test/fixtures/fingerprint-schema-stale.prisma';

  it('says nothing when the map has no source (pre-0.60 or hand-written)', async () => {
    await withEnv('development', async () => {
      assert.deepEqual(await run(undefined, 'silence'), []);
    });
  });

  it('says nothing when the file is missing, which is the normal deployed state', async () => {
    await withEnv('development', async () => {
      assert.deepEqual(await run({ path: 'prisma/does-not-exist.prisma', hash: 'v1:0000000000000000' }, 'silence'), []);
    });
  });

  it('warns, naming the file and the fix, when the hash no longer matches', async () => {
    await withEnv('development', async () => {
      const warned = await run({ path: stalePath, hash: 'v1:ffffffffffffffff' }, 'warning');
      assert.equal(warned.length, 1);
      assert.match(warned[0]!, /fingerprint-schema-stale\.prisma has changed/);
      assert.match(warned[0]!, /turbine migrate-from-prisma/);
    });
  });

  it('says nothing when the hash still matches', async () => {
    await withEnv('development', async () => {
      const { readFileSync } = await import('node:fs');
      const hash = fingerprintPrismaSchema(readFileSync(realPath, 'utf8'));
      assert.deepEqual(await run({ path: realPath, hash }, 'silence'), []);
    });
  });

  it('is silent in production even when the map is stale', async () => {
    await withEnv('production', async () => {
      assert.deepEqual(await run({ path: stalePath, hash: 'v1:ffffffffffffffff' }, 'silence'), []);
    });
  });

  it('warns once per path, not once per client', async () => {
    await withEnv('development', async () => {
      resetWarnOnce(WARN_NS.stalePrismaMap);
      const first = await runNoReset({ path: stalePath, hash: 'v1:ffffffffffffffff' }, 'warning');
      const second = await runNoReset({ path: stalePath, hash: 'v1:ffffffffffffffff' }, 'silence');
      assert.equal(first.length, 1);
      assert.equal(second.length, 0, 'a second client must not repeat it');
    });
  });

  /** As {@link run}, minus the registry reset, so repeat calls are observable. */
  async function runNoReset(source: PrismaCompatMap['source'], expect: 'warning' | 'silence'): Promise<string[]> {
    const { createPrismaCompatClient } = await import('../prisma-compat.js');
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...a: unknown[]) => {
      warned.push(a.join(' '));
    };
    try {
      const stub = {
        schema: { tables: { users: { name: 'users', columns: [], primaryKey: ['id'], relations: {} } } },
        table: () => ({}),
      };
      createPrismaCompatClient(stub as never, { ...MAP, source });
      // Same deadline rule as `run`, and for the same reason.
      const mine = () => warned.filter((w) => w.includes('prisma-map') && (source ? w.includes(source.path) : true));
      const deadline = Date.now() + (expect === 'warning' ? 10_000 : 1_000);
      while (Date.now() < deadline) {
        if (expect === 'warning' && mine().length) break;
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      console.warn = original;
    }
    return warned.filter((w) => w.includes('prisma-map') && (source ? w.includes(source.path) : true));
  }
});

// ---------------------------------------------------------------------------
// The postinstall flag
// ---------------------------------------------------------------------------

describe('parseArgs, migrate-from-prisma --if-db', () => {
  it('parses --if-db alongside the other flags', async () => {
    const { parseArgs } = await import('../cli/index.js');
    const a = parseArgs(['migrate-from-prisma', '--if-db', '--allow-partial']);
    assert.equal(a.command, 'migrate-from-prisma');
    assert.equal(a.ifDb, true);
    assert.equal(a.allowPartial, true);
  });

  it('leaves ifDb undefined when absent, so the default stays fail-on-missing-url', async () => {
    const { parseArgs } = await import('../cli/index.js');
    assert.equal(parseArgs(['migrate-from-prisma']).ifDb, undefined);
  });

  it('is distinct from --no-db: one skips the run, the other runs without a database', async () => {
    const { parseArgs } = await import('../cli/index.js');
    const a = parseArgs(['migrate-from-prisma', '--if-db']);
    assert.equal(a.noDb, undefined);
    const b = parseArgs(['migrate-from-prisma', '--no-db']);
    assert.equal(b.ifDb, undefined);
  });
});
