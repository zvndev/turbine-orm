/**
 * turbine-orm, the first five minutes: paths and starter files
 *
 * Three failures a new user hits before they have written a query.
 *
 *  D4 `turbine init` against an EMPTY database scaffolded an all-commented-out
 *     schema, generated a client with no table accessors, and then printed
 *     "const users = await db.users.findMany()". Nothing in that sequence works
 *     and nothing said so.
 *  D5 The import it printed, and the one in the README, was
 *     `'./generated/turbine'`, which is TS2834 under `moduleResolution:
 *     NodeNext`: this package ships NodeNext and its own tsconfig uses it. The
 *     generator has always appended the extension to its OWN sibling imports.
 *  D6 `--schema` is the Postgres NAMESPACE. Passed a file path (the mistake the
 *     examples themselves shipped) `push` reported
 *     "Schema file not found: ./turbine/schema.ts", naming a path the user
 *     never typed. The detection for it existed and was wired into `generate`
 *     alone.
 *
 * Run: npx tsx --test src/test/cli-first-run.paths.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { looksLikeSchemaFilePath, resolveConfig } from '../cli/config.js';
import { generatedClientImport, initSchemaTemplate, parseArgs, refuseSchemaFilePath } from '../cli/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SOURCE = readFileSync(resolve(__dirname, '../cli/index.ts'), 'utf-8');

const EXITED = Symbol('process.exit called');

/** Run `fn`, capturing stderr and any `process.exit`. */
function capture(fn: () => void): { exited: number | null; stderr: string; stdout: string } {
  const realLog = console.log;
  const realError = console.error;
  const realExit = process.exit;
  const out: string[] = [];
  const err: string[] = [];
  let exited: number | null = null;
  console.log = (...p: unknown[]) => {
    out.push(p.map(String).join(' '));
  };
  console.error = (...p: unknown[]) => {
    err.push(p.map(String).join(' '));
  };
  process.exit = ((code?: number) => {
    exited = code ?? 0;
    throw EXITED;
  }) as unknown as typeof process.exit;
  try {
    fn();
  } catch (e) {
    if (e !== EXITED) throw e;
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exit = realExit;
  }
  return { exited, stderr: err.join('\n'), stdout: out.join('\n') };
}

// ---------------------------------------------------------------------------
// D5, the printed import path
// ---------------------------------------------------------------------------

describe('the generated-client import the CLI prints', () => {
  it('carries the file extension NodeNext requires', () => {
    const line = generatedClientImport({ out: './generated/turbine', importExtension: 'js' });
    assert.equal(line, "import { turbine } from './generated/turbine/index.js';");
    // The exact shape that is a TS2834, kept as a negative control: without it
    // this test passes for any string containing "turbine".
    assert.notEqual(line, "import { turbine } from './generated/turbine';");
  });

  it('drops the extension under bundler resolution, where the directory form is right', () => {
    const line = generatedClientImport({ out: './generated/turbine', importExtension: 'none' });
    assert.equal(line, "import { turbine } from './generated/turbine';");
  });

  it('honours a custom --out and normalizes the path', () => {
    assert.equal(
      generatedClientImport({ out: 'db/client/', importExtension: 'js' }),
      "import { turbine } from './db/client/index.js';",
    );
    assert.equal(
      generatedClientImport({ out: './src/gen', importExtension: 'js' }),
      "import { turbine } from './src/gen/index.js';",
    );
  });

  it('is the ONLY spelling the CLI prints (no hardcoded copy survived)', () => {
    // Both `init`'s next-steps and `generate`'s usage hint used to build this
    // string inline, and both were wrong in the same way.
    assert.ok(
      !CLI_SOURCE.includes("import { turbine } from './${config.out"),
      'a hand-built import line is back; route it through generatedClientImport',
    );
    const uses = CLI_SOURCE.match(/generatedClientImport\(config\)/g) ?? [];
    assert.equal(uses.length, 2, 'init next-steps and generate usage hint must both use the helper');
  });
});

// ---------------------------------------------------------------------------
// D4, the starter schema and the next-steps text
// ---------------------------------------------------------------------------

describe('the starter schema init scaffolds', () => {
  it('is a REAL schema when the database has no tables', () => {
    const t = initSchemaTemplate(false);
    // Not commented out: `push` must have something to create, otherwise
    // `generate` emits a client with no accessors and the next-steps text is a
    // promise nothing can keep.
    assert.match(t, /^\s*users: \{$/m);
    assert.match(t, /^\s*posts: \{$/m);
    assert.match(t, /references: 'users\.id'/);
    assert.doesNotMatch(t, /^\s*\/\/\s*users: \{$/m);
  });

  it('stays a placeholder when the database ALREADY has tables', () => {
    // `init --with-schema` beside a populated database: an example `users`
    // table there is a schema diff against somebody's real data.
    const t = initSchemaTemplate(true);
    assert.doesNotMatch(t, /^\s*users: \{$/m);
    assert.match(t, /^\s*\/\/\s*users: \{$/m);
  });

  it('both shapes are a valid defineSchema module', () => {
    for (const t of [initSchemaTemplate(false), initSchemaTemplate(true)]) {
      assert.match(t, /import \{ defineSchema \} from 'turbine-orm';/);
      assert.match(t, /export default defineSchema\(\{/);
    }
  });
});

describe("init's next steps depend on what was generated", () => {
  /** The `else if` / `else` chain that prints the next steps. */
  const nextSteps = (() => {
    const start = CLI_SOURCE.indexOf("bold('Next steps:')");
    assert.ok(start > 0, 'the next-steps block must be findable');
    return CLI_SOURCE.slice(start, start + 3000);
  })();

  it('branches on the table count rather than assuming one', () => {
    assert.match(nextSteps, /generated\.tableCount === null \|\| generated\.tableCount === 0/);
  });

  it('names a table the client really has, not a hardcoded users', () => {
    assert.match(nextSteps, /generated\.sampleAccessor/);
    assert.match(nextSteps, /db\.\$\{accessor\}\.findMany\(\)/);
  });

  it('the empty-database branch does not tell you to import anything', () => {
    const emptyBranch = nextSteps.slice(
      nextSteps.indexOf('generated.tableCount === 0'),
      nextSteps.indexOf('} else {', nextSteps.indexOf('generated.tableCount === 0')),
    );
    assert.ok(emptyBranch.length > 100, 'anti-vacuous: the branch must have been found');
    assert.doesNotMatch(emptyBranch, /import \{ turbine \}/);
    assert.match(emptyBranch, /npx turbine push/);
    assert.match(emptyBranch, /npx turbine generate/);
  });
});

// ---------------------------------------------------------------------------
// D6, --schema is the namespace and --schema-file is the file
// ---------------------------------------------------------------------------

describe('--schema-file', () => {
  it('parses and overrides the config value', () => {
    assert.equal(parseArgs(['push', '--schema-file', './schema.ts']).schemaFile, './schema.ts');
    const config = resolveConfig({ schemaFile: './turbine/schema.ts' }, { schemaFile: './schema.ts' });
    assert.equal(config.schemaFile, './schema.ts', 'the flag must win over the config file');
  });

  it('leaves the config value alone when absent', () => {
    assert.equal(parseArgs(['push']).schemaFile, undefined);
    assert.equal(resolveConfig({ schemaFile: './turbine/schema.ts' }, {}).schemaFile, './turbine/schema.ts');
  });

  it('does not disturb --schema, which is a different idea', () => {
    const args = parseArgs(['push', '--schema', 'analytics', '--schema-file', './schema.ts']);
    assert.equal(args.schema, 'analytics');
    assert.equal(args.schemaFile, './schema.ts');
  });
});

describe('a --schema value that is plainly a file path', () => {
  it('is refused, naming --schema-file', () => {
    const { exited, stderr } = capture(() =>
      refuseSchemaFilePath({ schema: './schema.ts', schemaFile: './turbine/schema.ts' }),
    );
    assert.equal(exited, 1);
    assert.match(stderr, /looks like a file path/);
    assert.match(stderr, /--schema-file \.\/schema\.ts/);
  });

  it('says nothing for a real schema NAME', () => {
    for (const schema of ['public', 'analytics', 'my_schema']) {
      const { exited, stderr } = capture(() => refuseSchemaFilePath({ schema, schemaFile: './turbine/schema.ts' }));
      assert.equal(exited, null, `${schema} must be accepted`);
      assert.equal(stderr, '');
      assert.equal(looksLikeSchemaFilePath(schema), false);
    }
  });

  it('offers the escape hatch only where one exists', () => {
    const withHatch = capture(() =>
      refuseSchemaFilePath({ schema: './s.ts', schemaFile: './x.ts' }, { escapeHatch: '--allow-empty' }),
    );
    assert.match(withHatch.stderr, /--allow-empty/);
    const without = capture(() => refuseSchemaFilePath({ schema: './s.ts', schemaFile: './x.ts' }));
    assert.doesNotMatch(without.stderr, /--allow-empty/);
  });

  it('is wired into every command that reads --schema as a namespace', () => {
    // It was written for `generate` and called from `generate` alone, so `push`,
    // the command whose flag name the mistake is about, kept the bad error.
    for (const command of [
      'cmdGenerate',
      'cmdPush',
      'cmdStatus',
      'cmdDoctor',
      'cmdStudio',
      'cmdMcp',
      'cmdMigrateCreate',
    ]) {
      const start = CLI_SOURCE.indexOf(`async function ${command}(`);
      assert.ok(start > 0, `${command} must exist`);
      const body = CLI_SOURCE.slice(start, start + 1200);
      assert.match(body, /refuseSchemaFilePath\(/, `${command} must run the guard`);
    }
  });

  it('is NOT wired into migrate-from-prisma, where --schema really is a file', () => {
    const start = CLI_SOURCE.indexOf('async function cmdMigrateFromPrisma(');
    assert.ok(start > 0);
    const body = CLI_SOURCE.slice(start, CLI_SOURCE.indexOf('\n}\n', start));
    assert.ok(!body.includes('refuseSchemaFilePath('), 'that command documents --schema as the .prisma FILE');
  });
});
