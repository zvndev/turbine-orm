/**
 * turbine-orm, CLI argument safety
 *
 * Three related failures of the same shape, all of them silent:
 *
 *  1. The arg parser's `default:` branch DISCARDED any token starting with `-`
 *     that it did not recognize. So `push --dry-runn` executed for real,
 *     `migrate create x --autoo` wrote an empty template and reported success,
 *     and `doctor --fixx` wrote nothing and exited 0. A typo in a safety flag
 *     disarmed the safety, with no output saying so.
 *  2. Every failure went to STDOUT. `turbine generate > build.log` swallowed
 *     the error whole and a CI step reading stderr saw an empty string beside a
 *     non-zero exit code.
 *  3. An unknown COMMAND one transposition from a real one just said "Unknown
 *     command".
 *
 * The drift guard at the bottom is the part that keeps working without being
 * edited: it reads the `case` labels out of `parseArgs` itself and requires the
 * flag table and the parser to name exactly the same set, in both directions.
 *
 * Run: npx tsx --test src/test/cli-arg-safety.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allFlagTokens, type CliArgs, flagsForCommand, knownCommands, parseArgs } from '../cli/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SOURCE = readFileSync(resolve(__dirname, '../cli/index.ts'), 'utf-8');

/**
 * A unique sentinel, deliberately NOT an Error subclass: the stubbed
 * `process.exit` has to unwind the stack, and a local `class ... extends Error`
 * trips `npm run check:error-codes` (see the same note in pooler-guard.test.ts).
 */
const EXITED = Symbol('process.exit called');

interface ParseOutcome {
  args?: CliArgs;
  exited: number | null;
  stdout: string;
  stderr: string;
}

/** Run `parseArgs`, capturing both streams and any `process.exit`. */
function run(argv: string[]): ParseOutcome {
  const realLog = console.log;
  const realError = console.error;
  const realExit = process.exit;
  const out: string[] = [];
  const err: string[] = [];
  let exited: number | null = null;
  let args: CliArgs | undefined;
  console.log = (...parts: unknown[]) => {
    out.push(parts.map(String).join(' '));
  };
  console.error = (...parts: unknown[]) => {
    err.push(parts.map(String).join(' '));
  };
  process.exit = ((code?: number) => {
    exited = code ?? 0;
    throw EXITED;
  }) as unknown as typeof process.exit;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e !== EXITED) throw e;
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exit = realExit;
  }
  return { args, exited, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('unknown flags are refused, not discarded', () => {
  it('rejects the three cases that were reproduced silently', () => {
    // Each of these previously parsed clean and let the command run.
    for (const argv of [
      ['migrate', 'create', 'typo_test', '--autoo'],
      ['push', '--dry-runn'],
      ['doctor', '--fixx'],
    ]) {
      const { exited, stderr } = run(argv);
      assert.equal(exited, 1, `${argv.join(' ')} must exit non-zero`);
      assert.match(stderr, /Unknown flag/, `${argv.join(' ')} must say what was wrong`);
    }
  });

  it('names the closest real flag', () => {
    assert.match(run(['push', '--dry-runn']).stderr, /Did you mean.*--dry-run/s);
    assert.match(run(['doctor', '--fixx']).stderr, /Did you mean.*--fix/s);
    assert.match(run(['migrate', 'create', 'x', '--autoo']).stderr, /Did you mean.*--auto/s);
  });

  it('offers only long spellings, never a short alias that happens to be a substring', () => {
    // `--no-opn` CONTAINS `-o`, and closestName scores containment above edit
    // distance, so a candidate list including short flags answers with `-o`.
    const { stderr } = run(['studio', '--no-opn']);
    assert.match(stderr, /Did you mean.*--no-open/s);
    assert.doesNotMatch(stderr, /Did you mean [^\n]*\s-o\?/);
  });

  it('lists the flags that command does accept', () => {
    const { stderr } = run(['doctor', '--fixx']);
    for (const flag of ['--fix', '--json', '--unused', '--allow-pooler']) {
      assert.ok(stderr.includes(flag), `doctor's rejection must list ${flag}`);
    }
    // ...and the globals, which are valid there too.
    assert.ok(stderr.includes('--url, -u'), 'the global flags must be listed with their aliases');
  });

  it('reports every bad flag on the line, not just the first', () => {
    const { stderr } = run(['doctor', '--fixx', '--jsonn']);
    assert.match(stderr, /--fixx/);
    assert.match(stderr, /--jsonn/);
  });

  it('refuses a real flag used on the wrong command', () => {
    // `--fix` is doctor's. Accepting it on `push` and doing nothing is the same
    // silence as a typo: the caller asked for something and got no answer.
    const { exited, stderr } = run(['push', '--fix']);
    assert.equal(exited, 1);
    assert.match(stderr, /Unknown flag/);
  });
});

describe('unknown flags do not fire on valid input', () => {
  it('accepts every documented flag on its own command', () => {
    const cases: string[][] = [
      ['init', '--yes', '--force', '--skip-schema', '--with-schema', '--skip-seed', '--skip-push', '--skip-generate'],
      ['generate', '--zod', '--include-views', '--no-timestamp', '--import-ext', 'js', '--keep-column-names'],
      ['generate', '--legacy-to-many-uniques', '--allow-empty', '--out', './x', '--schema', 'public'],
      ['pull', '--include', 'a,b', '--exclude', 'c'],
      ['push', '--dry-run', '--allow-destructive', '--verbose'],
      ['migrate', 'create', 'name', '--auto'],
      ['migrate', 'create', 'name', '--from-diff'],
      ['migrate', 'create', 'name', '--recipe', 'backfill'],
      ['migrate', 'up', '--step', '2', '--allow-drift', '--allow-destructive', '--dry-run'],
      ['migrate', 'down', '-n', '1'],
      ['seed', '--url', 'postgres://x/y'],
      ['status', '-s', 'public'],
      ['doctor', '--fix', '--json', '--no-concurrently', '--unused', '--audit', '--min-scans', '5'],
      ['doctor', '--metrics-url', 'postgres://x/y', '--no-plan-divergence', '--allow-pooler'],
      ['studio', '--port', '5000', '--host', '::1', '--no-open', '--allow-remote', '--write', '--show-pii'],
      ['studio', '--demo'],
      ['observe', '--port', '4984', '--host', '127.0.0.1', '--no-open'],
      ['mcp', '--schema', 'public'],
      ['skill', '--print'],
      ['skill', '--agents'],
      ['skill', '--dir', './skills'],
      ['migrate-from-prisma', '--schema', 'prisma/schema.prisma', '--no-db', '--allow-partial', '--if-db'],
      ['push', '--schema-file', './schema.ts'],
      ['migrate', 'create', 'x', '--schema-file', './schema.ts', '--auto'],
      ['init', '--schema-file', './db/schema.ts'],
    ];
    for (const argv of cases) {
      const { exited, stderr } = run(argv);
      assert.equal(exited, null, `${argv.join(' ')} must parse: ${stderr}`);
    }
  });

  it('does not mistake a flag VALUE for a flag, including a negative number', () => {
    // Values are consumed by their own case on the same cursor, so they never
    // reach the unknown-flag test.
    assert.equal(run(['studio', '--host', '-weird']).exited, null);
    assert.equal(run(['doctor', '--min-scans', '-5']).exited, null);
  });

  it('a refused flag VALUE is refused as a VALUE, never reported as an unknown flag', () => {
    // `--step -1` used to parse clean and mean "every migration except the
    // oldest", so `--step` refuses a value that is not a positive count. That
    // refusal must name the FLAG, which is what proves the value was consumed
    // by `--step` rather than falling through to the unknown-flag test and
    // being reported as a flag named `-1`.
    //
    // It goes through `failArg` like every other flag refusal (banner, red
    // line, hints, exit 1) rather than throwing past main(), which printed one
    // unstyled sentence that read like an internal crash. Asserted on the exit
    // code and the two things the reader needs (the flag, the offending value),
    // never the full sentence: wording is not part of the stability contract.
    const { exited, stderr, args } = run(['migrate', 'down', '--step', '-1']);
    assert.equal(exited, 1);
    assert.equal(args, undefined, 'a refused value must never reach the command');
    assert.match(stderr, /--step/);
    assert.match(stderr, /-1/);
    assert.doesNotMatch(stderr, /Unknown flag/);
  });

  it('but a flag VALUE is not judged at all when the COMMAND is unknown', () => {
    // Order matters to the reader: `turbine genrate --step 0` has two problems
    // and only one of them is worth acting on. The `--step` check used to run
    // mid-loop, so it fired first and the misspelled command was never
    // mentioned. main()'s dispatch reports the command instead.
    const { exited, stderr } = run(['genrate', '--step', '0']);
    assert.equal(exited, null, 'flag-value validation must not run for an unrecognized command');
    assert.doesNotMatch(stderr, /--step/);
  });

  it("leaves an unknown command's flags alone, so the command error is what surfaces", () => {
    // `--url` is fine; the problem is `genrate`. Reporting a flag error here
    // would send the reader after the wrong thing.
    const { exited } = run(['genrate', '--url', 'postgres://x/y']);
    assert.equal(exited, null, 'flag validation must not run for an unrecognized command');
  });

  it('help and version reach their handlers untouched', () => {
    for (const argv of [['--help'], ['-h'], ['--version'], ['-V'], ['help'], ['version'], []]) {
      assert.equal(run(argv).exited, null, `${argv.join(' ') || '(no args)'} must not be rejected`);
    }
    assert.equal(run(['push', '--help']).args?.help, true);
  });
});

describe('failures go to stderr, and stdout stays empty', () => {
  it('a rejected flag writes nothing at all to stdout', () => {
    const { stdout, stderr } = run(['push', '--dry-runn']);
    assert.equal(stdout, '', `stdout must be empty on a pure failure, got: ${stdout}`);
    assert.ok(stderr.length > 0, 'the whole refusal belongs on stderr');
    // The banner is part of the message, so it moves with it.
    assert.match(stderr, /turbine-orm/);
  });

  it('ui.error / ui.warn write to stderr, not stdout', () => {
    const ui = readFileSync(resolve(__dirname, '../cli/ui.ts'), 'utf-8');
    for (const fn of ['export function error', 'export function warn', 'export function errorLine']) {
      const body = ui.slice(ui.indexOf(fn), ui.indexOf('}', ui.indexOf(fn)));
      assert.ok(body.includes('console.error'), `${fn} must write to stderr`);
      assert.ok(!body.includes('console.log'), `${fn} must not write to stdout`);
    }
    // Progress output stays where it was.
    const success = ui.slice(
      ui.indexOf('export function success'),
      ui.indexOf('}', ui.indexOf('export function success')),
    );
    assert.ok(success.includes('console.log'), 'success() is progress output and stays on stdout');
  });

  it('Spinner.fail writes to stderr', () => {
    const ui = readFileSync(resolve(__dirname, '../cli/ui.ts'), 'utf-8');
    const fail = ui.slice(ui.indexOf('  fail(msg?: string)'), ui.indexOf('  info(msg?: string)'));
    assert.ok(fail.includes('process.stderr.write'), 'a failed step is a failure');
    assert.ok(!fail.includes('process.stdout.write'), 'and must not also print to stdout');
  });
});

describe('unknown commands suggest the real one', () => {
  it('the dispatch default names a suggestion', () => {
    // parseArgs cannot reach the dispatcher, so this asserts the wiring: the
    // suggestion is computed from the canonical command names only.
    const dispatch = CLI_SOURCE.slice(CLI_SOURCE.indexOf('error(`Unknown command:'));
    const block = dispatch.slice(0, dispatch.indexOf('process.exit(1)'));
    assert.match(block, /closestName\(args\.command, knownCommands\(\)\)/);
    assert.match(block, /Did you mean/);
  });

  it('the canonical command list holds no one-letter aliases', () => {
    // `closestName` scores containment above edit distance, so an alias like
    // `g` would beat `generate` for the input `genrate` (501 vs 99).
    for (const name of knownCommands()) {
      assert.ok(name.length > 2, `${name} is too short to be a safe suggestion candidate`);
    }
  });

  it('covers every command the dispatcher handles', () => {
    for (const command of [
      'init',
      'generate',
      'migrate-from-prisma',
      'push',
      'migrate',
      'seed',
      'status',
      'doctor',
      'studio',
      'mcp',
      'observe',
      'skill',
    ]) {
      assert.ok(knownCommands().includes(command), `${command} must be a known command`);
      assert.ok(flagsForCommand(command), `${command} must have a flag list`);
    }
    // Aliases resolve to the canonical entry rather than getting their own.
    for (const alias of ['gen', 'g', 'pull', 'migration', 'm', 's', 'info']) {
      assert.ok(flagsForCommand(alias), `${alias} must resolve to a known command`);
      assert.ok(!knownCommands().includes(alias), `${alias} must not be offered as a suggestion`);
    }
  });
});

describe('the flag table and the parser cannot drift apart', () => {
  /** Every `case '--x':` / `case '-x':` label inside parseArgs. */
  function parserCaseLabels(): Set<string> {
    const start = CLI_SOURCE.indexOf('export function parseArgs(');
    assert.ok(start > 0, 'parseArgs must be findable in the source');
    const end = CLI_SOURCE.indexOf('\n}\n', start);
    const body = CLI_SOURCE.slice(start, end);
    const labels = new Set<string>();
    for (const m of body.matchAll(/case '(-{1,2}[A-Za-z][A-Za-z0-9-]*)':/g)) labels.add(m[1]!);
    return labels;
  }

  it('finds the parser cases at all (anti-vacuous)', () => {
    const labels = parserCaseLabels();
    assert.ok(labels.size > 30, `expected the full flag surface, found ${labels.size}`);
    assert.ok(labels.has('--dry-run'), 'sanity: --dry-run is a parser case');
  });

  it('every flag the tables accept is handled by the parser', () => {
    const labels = parserCaseLabels();
    for (const token of allFlagTokens()) {
      assert.ok(labels.has(token), `${token} is accepted by a command but has no case in parseArgs (silently ignored)`);
    }
  });

  it('every flag the parser handles is accepted by some command', () => {
    const declared = allFlagTokens();
    for (const label of parserCaseLabels()) {
      assert.ok(declared.has(label), `${label} is parsed but on no command's list, so it can never reach its case`);
    }
  });

  it('every long flag is documented in the help text', () => {
    // The help block is what the rejection message tells the reader to run.
    for (const command of knownCommands()) {
      const flags = flagsForCommand(command);
      assert.ok(flags);
      for (const flag of flags.own) {
        // Help lines render a flag either alone or with its alias attached
        // (`cyan('--step, -n')`), so match the opening of the cyan() call.
        const documented = new RegExp(`cyan\\('${flag.replace(/-/g, '-')}(,|')`);
        assert.ok(documented.test(CLI_SOURCE), `${flag} (${command}) is accepted but documented nowhere`);
      }
    }
  });
});
