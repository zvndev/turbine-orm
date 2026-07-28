/**
 * turbine-orm, CLI secret handling + init/help ergonomics.
 *
 * Pure, DB-free unit tests for:
 *   1. `turbine init --url <string-with-password>`, the password must never
 *      reach the committed `turbine.config.ts`, and the `.env` / `.env.example`
 *      / `.gitignore` scaffold that replaces it.
 *   2. `planInitSteps`, the empty-schema-file scaffold against a database that
 *      already has tables.
 *   3. `showSubcommandHelp`, every flag-bearing command has real help instead
 *      of falling through to the global help.
 *
 * Run: npx tsx --test src/test/cli-init-secrets.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { configTemplate, connectionStringHasPassword } from '../cli/config.js';
import {
  type EnvScaffoldState,
  gitignoreIgnoresEnv,
  type InitPlanFlags,
  type InitPlanState,
  parseArgs,
  planEnvScaffold,
  planInitSteps,
  scaffoldEnvForUrl,
  showSubcommandHelp,
} from '../cli/index.js';
import { redactUrl } from '../cli/ui.js';

// ---------------------------------------------------------------------------
// connectionStringHasPassword
// ---------------------------------------------------------------------------

describe('connectionStringHasPassword', () => {
  it('reports true for a URL connection string carrying a password', () => {
    assert.equal(connectionStringHasPassword('postgres://user:s3cret@host:5432/db'), true);
    assert.equal(connectionStringHasPassword('postgresql://user:s3cret@host/db?sslmode=require'), true);
  });

  it('reports false for a URL with no password component', () => {
    assert.equal(connectionStringHasPassword('postgres://user@host:5432/db'), false);
    assert.equal(connectionStringHasPassword('postgres://host:5432/db'), false);
    // An explicitly EMPTY password is not a secret worth relocating.
    assert.equal(connectionStringHasPassword('postgres://user:@host/db'), false);
  });

  it('reports true for the libpq keyword form, which is not a URL', () => {
    assert.equal(connectionStringHasPassword('host=localhost user=app password=s3cret dbname=app'), true);
    assert.equal(connectionStringHasPassword('host=localhost user=app dbname=app'), false);
  });

  it('reports false for an empty or whitespace-only value', () => {
    assert.equal(connectionStringHasPassword(''), false);
    assert.equal(connectionStringHasPassword('   '), false);
  });

  // The form that shipped undetected. `new URL` parses it, `parsed.password` is
  // empty, and the first version returned false on the reasoning that a valid
  // URL rules out the keyword form. libpq and pg-connection-string both read the
  // password straight out of the query string.
  it('reports true for a password passed as a URL query parameter', () => {
    assert.equal(connectionStringHasPassword('postgres://app@db.example.com:5432/appdb?password=s3cret'), true);
    assert.equal(connectionStringHasPassword('postgres://app@host/db?sslmode=require&password=s3cret'), true);
    assert.equal(connectionStringHasPassword('postgres://app@host/db?password=s3cret&sslmode=require'), true);
    assert.equal(connectionStringHasPassword('postgres://app@host/db?PASSWORD=s3cret'), true);
    // libpq's other password parameter.
    assert.equal(connectionStringHasPassword('postgres://app@host/db?sslpassword=s3cret'), true);
    // Both spellings at once, and the userinfo form alongside a query one.
    assert.equal(connectionStringHasPassword('postgres://app:pw@host/db?password=s3cret'), true);
  });

  it('reports false for a query string that carries no password value', () => {
    assert.equal(connectionStringHasPassword('postgres://app@host/db?sslmode=require'), false);
    // Present but empty: nothing to relocate.
    assert.equal(connectionStringHasPassword('postgres://app@host/db?password='), false);
    assert.equal(connectionStringHasPassword('postgres://app@host/db?password=&sslmode=require'), false);
  });

  it('reports true for the keyword form of sslpassword', () => {
    assert.equal(connectionStringHasPassword('host=localhost user=app sslpassword=s3cret'), true);
    assert.equal(connectionStringHasPassword('host=localhost user=app password='), false);
  });

  // The two functions are one definition of "this carries a secret". If the
  // redactor hides a spelling the detector calls safe, that spelling gets
  // committed into turbine.config.ts while the terminal shows it redacted.
  it('is at least as strong as redactUrl, the detector shipped beside it', () => {
    const secrets = [
      'postgres://user:s3cret@host:5432/db',
      'postgres://app@host/db?password=s3cret',
      'postgres://app@host/db?sslpassword=s3cret',
      'postgres://app@host/db?sslmode=require&password=s3cret#frag',
      'postgresql://u:s3cret@a/db?password=s3cret',
    ];
    for (const url of secrets) {
      assert.ok(!redactUrl(url).includes('s3cret'), `redactUrl left the secret in: ${url}`);
      assert.equal(connectionStringHasPassword(url), true, `detector missed: ${url}`);
    }
  });
});

// ---------------------------------------------------------------------------
// configTemplate
// ---------------------------------------------------------------------------

describe('configTemplate', () => {
  it('never writes a password into the config, reading process.env.DATABASE_URL instead', () => {
    const out = configTemplate('postgres://user:s3cret@host:5432/db');
    assert.ok(!out.includes('s3cret'), 'the password must not appear anywhere in the generated config');
    assert.ok(out.includes('url: process.env.DATABASE_URL'));
  });

  it('still inlines a password-free connection string', () => {
    const out = configTemplate('postgres://user@host:5432/db');
    assert.ok(out.includes("url: 'postgres://user@host:5432/db'"));
  });

  it('never inlines a query-parameter password either', () => {
    const out = configTemplate('postgres://app@db.example.com:5432/appdb?password=s3cret');
    assert.ok(!out.includes('s3cret'), 'the query-string password must not appear in the generated config');
    assert.ok(out.includes('url: process.env.DATABASE_URL'));
  });

  it('reads process.env.DATABASE_URL when given no connection string', () => {
    assert.ok(configTemplate().includes('url: process.env.DATABASE_URL'));
  });

  it('escapes quotes so an odd connection string cannot break the emitted TypeScript', () => {
    const out = configTemplate("postgres://host/db?options='x'");
    assert.ok(out.includes("\\'x\\'"), `expected escaped quotes, got: ${out}`);
    assert.ok(!/url: '[^\n]*[^\\]'[^,\n]/.test(out));
  });
});

// ---------------------------------------------------------------------------
// gitignoreIgnoresEnv
// ---------------------------------------------------------------------------

describe('gitignoreIgnoresEnv', () => {
  it('recognizes the patterns that actually ignore a root-level .env', () => {
    assert.equal(gitignoreIgnoresEnv('.env\n'), true);
    assert.equal(gitignoreIgnoresEnv('node_modules\n/.env\n'), true);
    assert.equal(gitignoreIgnoresEnv('.env*\n'), true);
    assert.equal(gitignoreIgnoresEnv('*.env\n'), true);
    assert.equal(gitignoreIgnoresEnv('**/.env\n'), true);
  });

  it('does NOT count a .env.example line as covering .env', () => {
    // A substring search on ".env" says yes here and leaves the password
    // committable, which is the whole reason this is line-based.
    assert.equal(gitignoreIgnoresEnv('node_modules\n!.env.example\n.env.example\n'), false);
  });

  it('ignores comments and honors a later negation', () => {
    assert.equal(gitignoreIgnoresEnv('# .env\n'), false);
    assert.equal(gitignoreIgnoresEnv('.env\n!.env\n'), false);
    assert.equal(gitignoreIgnoresEnv('!.env\n.env\n'), true);
  });

  it('reports false for an empty file', () => {
    assert.equal(gitignoreIgnoresEnv(''), false);
  });
});

// ---------------------------------------------------------------------------
// planEnvScaffold
// ---------------------------------------------------------------------------

const freshEnvState: EnvScaffoldState = {
  envExists: false,
  envHasDatabaseUrl: false,
  envExampleExists: false,
  gitignoreExists: false,
  gitignoreIgnoresEnv: false,
};

describe('planEnvScaffold', () => {
  it('creates all three files in a fresh project', () => {
    assert.deepEqual(planEnvScaffold(freshEnvState), {
      env: 'created',
      envExample: 'created',
      gitignore: 'created',
    });
  });

  it('appends DATABASE_URL to an existing .env that does not set it', () => {
    const plan = planEnvScaffold({ ...freshEnvState, envExists: true });
    assert.equal(plan.env, 'appended');
  });

  it('never rewrites an existing DATABASE_URL', () => {
    const plan = planEnvScaffold({ ...freshEnvState, envExists: true, envHasDatabaseUrl: true });
    assert.equal(plan.env, 'unchanged');
  });

  it('appends .env to a .gitignore that does not cover it, and leaves a covering one alone', () => {
    assert.equal(planEnvScaffold({ ...freshEnvState, gitignoreExists: true }).gitignore, 'appended');
    assert.equal(
      planEnvScaffold({ ...freshEnvState, gitignoreExists: true, gitignoreIgnoresEnv: true }).gitignore,
      'unchanged',
    );
  });

  it('is idempotent on a second run (nothing to write)', () => {
    assert.deepEqual(
      planEnvScaffold({
        envExists: true,
        envHasDatabaseUrl: true,
        envExampleExists: true,
        gitignoreExists: true,
        gitignoreIgnoresEnv: true,
      }),
      { env: 'unchanged', envExample: 'unchanged', gitignore: 'unchanged' },
    );
  });
});

// ---------------------------------------------------------------------------
// scaffoldEnvForUrl, the files that actually land on disk
// ---------------------------------------------------------------------------

/** Run `fn` inside a throwaway directory, always restoring the original cwd. */
function inTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-init-'));
  const previous = process.cwd();
  try {
    process.chdir(dir);
    fn(dir);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('scaffoldEnvForUrl', () => {
  it('writes the password to .env, scaffolds .env.example, and creates a .gitignore covering .env', () => {
    inTempDir((dir) => {
      const plan = scaffoldEnvForUrl('postgres://user:s3cret@host:5432/db');
      assert.deepEqual(plan, { env: 'created', envExample: 'created', gitignore: 'created' });

      const env = readFileSync(join(dir, '.env'), 'utf-8');
      assert.ok(env.includes('DATABASE_URL=postgres://user:s3cret@host:5432/db'));

      const example = readFileSync(join(dir, '.env.example'), 'utf-8');
      assert.ok(!example.includes('s3cret'), '.env.example is committed and must carry no real password');

      assert.equal(gitignoreIgnoresEnv(readFileSync(join(dir, '.gitignore'), 'utf-8')), true);
    });
  });

  // A file holding a live database password at 0644 is readable by every
  // account on a shared box or CI runner, which undoes the point of moving it
  // out of the committed config.
  it('creates .env with owner-only permissions', { skip: process.platform === 'win32' }, () => {
    inTempDir((dir) => {
      scaffoldEnvForUrl('postgres://user:s3cret@host/db');
      assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
    });
  });

  it('never changes the mode of a .env it did not create', () => {
    inTempDir((dir) => {
      const envPath = join(dir, '.env');
      writeFileSync(envPath, 'OTHER=1\n', { encoding: 'utf-8', mode: 0o644 });
      const before = statSync(envPath).mode;
      const plan = scaffoldEnvForUrl('postgres://user:s3cret@host/db');
      assert.equal(plan.env, 'appended');
      assert.equal(statSync(envPath).mode, before, "an existing file's mode belongs to its owner");
    });
  });

  it('appends to an existing .gitignore rather than replacing it', () => {
    inTempDir((dir) => {
      writeFileSync(join(dir, '.gitignore'), 'node_modules\ndist\n', 'utf-8');
      const plan = scaffoldEnvForUrl('postgres://user:s3cret@host/db');
      assert.equal(plan.gitignore, 'appended');
      const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
      assert.ok(content.includes('node_modules'), 'existing entries must survive');
      assert.equal(gitignoreIgnoresEnv(content), true);
    });
  });

  it('leaves an existing DATABASE_URL in .env alone', () => {
    inTempDir((dir) => {
      writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://existing@host/db\n', 'utf-8');
      const plan = scaffoldEnvForUrl('postgres://user:s3cret@host/db');
      assert.equal(plan.env, 'unchanged');
      const env = readFileSync(join(dir, '.env'), 'utf-8');
      assert.ok(!env.includes('s3cret'), "the caller's --url must not overwrite the project's own value");
    });
  });

  it('is idempotent: a second run writes nothing new', () => {
    inTempDir((dir) => {
      scaffoldEnvForUrl('postgres://user:s3cret@host/db');
      const before = readFileSync(join(dir, '.gitignore'), 'utf-8');
      const plan = scaffoldEnvForUrl('postgres://user:s3cret@host/db');
      assert.deepEqual(plan, { env: 'unchanged', envExample: 'unchanged', gitignore: 'unchanged' });
      assert.equal(readFileSync(join(dir, '.gitignore'), 'utf-8'), before);
    });
  });
});

// ---------------------------------------------------------------------------
// planInitSteps, empty schema file against a populated database
// ---------------------------------------------------------------------------

const populatedState: InitPlanState = {
  configExists: false,
  schemaExists: false,
  seedFileExists: false,
  hasUrl: true,
  dbReachable: true,
  dbHasTables: true,
};

const baseFlags: InitPlanFlags = {
  yes: false,
  force: false,
  interactive: false,
  skipSchema: false,
  skipSeed: false,
  skipPush: false,
  skipGenerate: false,
};

function schemaStep(state: InitPlanState, flags: InitPlanFlags) {
  const s = planInitSteps(state, flags).find((p) => p.id === 'schema');
  assert.ok(s);
  return s;
}

describe('planInitSteps, schema scaffold vs an already-populated database', () => {
  it('skips the empty schema file (db-has-tables) when the database already has tables', () => {
    const step = schemaStep(populatedState, { ...baseFlags, yes: true });
    assert.equal(step.action, 'skip');
    assert.equal(step.skipReason, 'db-has-tables');
  });

  it('prompts with a NO default on a TTY instead of scaffolding silently', () => {
    const step = schemaStep(populatedState, { ...baseFlags, interactive: true });
    assert.equal(step.action, 'prompt');
    assert.equal(step.defaultYes, false);
  });

  it('still scaffolds the starter schema for an empty database', () => {
    const step = schemaStep({ ...populatedState, dbHasTables: false }, { ...baseFlags, yes: true });
    assert.equal(step.action, 'run');
  });

  it('treats an unprobed database (dbHasTables absent) exactly as before', () => {
    const { dbHasTables: _dropped, ...unprobed } = populatedState;
    const step = schemaStep(unprobed, { ...baseFlags, yes: true });
    assert.equal(step.action, 'run');
  });

  // Without an escape hatch this default is a behavior change nobody can undo:
  // a code-first project bootstrapping in CI against a populated database
  // silently stopped getting the starter file it used to get.
  it('scaffolds it anyway under --with-schema', () => {
    assert.equal(schemaStep(populatedState, { ...baseFlags, yes: true, withSchema: true }).action, 'run');
  });

  it('--with-schema returns the step to the normal path on a TTY (prompt, default yes)', () => {
    const step = schemaStep(populatedState, { ...baseFlags, interactive: true, withSchema: true });
    assert.equal(step.action, 'prompt');
    assert.equal(step.defaultYes, true);
  });

  it('--skip-schema still wins over --with-schema, being the explicit "do not"', () => {
    const step = schemaStep(populatedState, { ...baseFlags, yes: true, skipSchema: true, withSchema: true });
    assert.equal(step.action, 'skip');
    assert.equal(step.skipReason, 'flag');
  });

  it('--with-schema does not resurrect a schema file that already exists', () => {
    const step = schemaStep({ ...populatedState, schemaExists: true }, { ...baseFlags, yes: true, withSchema: true });
    assert.equal(step.action, 'skip');
    assert.equal(step.skipReason, 'exists');
  });

  it('parseArgs understands --with-schema', () => {
    assert.equal(parseArgs(['init', '--with-schema']).withSchema, true);
    assert.equal(parseArgs(['init']).withSchema, undefined);
  });

  it('leaves the seed-file scaffold untouched by the table count', () => {
    const seed = planInitSteps(populatedState, { ...baseFlags, yes: true }).find((p) => p.id === 'seed-file');
    assert.ok(seed);
    assert.equal(seed.action, 'run');
  });
});

// ---------------------------------------------------------------------------
// showSubcommandHelp
// ---------------------------------------------------------------------------

/** Run `fn` with console.log captured, returning everything it printed. */
function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

describe('showSubcommandHelp', () => {
  it('has real help for every command whose flags the global help only summarizes', () => {
    for (const command of ['init', 'generate', 'push', 'migrate', 'seed', 'status', 'doctor', 'studio', 'mcp']) {
      let handled = false;
      captureLog(() => {
        handled = showSubcommandHelp(command);
      });
      assert.equal(handled, true, `${command} --help must not fall through to the global help`);
    }
  });

  it('returns false for a command with no dedicated help', () => {
    let handled = true;
    captureLog(() => {
      handled = showSubcommandHelp('definitely-not-a-command');
    });
    assert.equal(handled, false);
  });

  it('doctor help documents each doctor-only flag', () => {
    const out = captureLog(() => showSubcommandHelp('doctor'));
    for (const flag of ['--fix', '--json', '--unused', '--audit', '--min-scans', '--no-plan-divergence']) {
      assert.ok(out.includes(flag), `doctor help must document ${flag}`);
    }
  });

  it('studio help documents each studio-only flag', () => {
    const out = captureLog(() => showSubcommandHelp('studio'));
    for (const flag of ['--write', '--demo', '--show-pii', '--allow-remote', '--port', '--host']) {
      assert.ok(out.includes(flag), `studio help must document ${flag}`);
    }
  });
});
