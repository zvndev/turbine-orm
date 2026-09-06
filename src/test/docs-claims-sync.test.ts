import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { TurbineErrorCode } from '../errors.js';

/**
 * Documented numbers, asserted against the file that owns them.
 *
 * Every claim below was corrected by hand once (0.65.0) and had drifted again
 * by 0.76.0, which is what a correction without a guard buys. So no number is
 * written down in this file: each assertion reads its own source of truth
 * (.c8rc.json, package.json, src/errors.ts, the seed fixture, the contents of
 * src/query/) and compares the document to it. A hardcoded expectation here
 * would just be a third copy of the same drifting number.
 */

const root = new URL('../../', import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, root), 'utf8');

describe('documented numbers match their source of truth', () => {
  it('STABILITY.md quotes the real .c8rc.json coverage floors', () => {
    const c8 = JSON.parse(read('.c8rc.json')) as Record<string, number>;
    const stability = read('STABILITY.md');

    for (const key of ['lines', 'statements', 'branches', 'functions'] as const) {
      const configured = c8[key];
      assert.equal(
        typeof configured,
        'number',
        `.c8rc.json must configure a numeric "${key}" threshold; this assertion cannot pass vacuously`,
      );
      const documented = stability.match(new RegExp(`${key}\\s+(\\d+)%`, 'i'));
      assert.ok(
        new RegExp(`${key}\\s+${configured}%`, 'i').test(stability),
        `STABILITY.md must quote ${key} ${configured}%, the value in .c8rc.json, but it says ` +
          `${documented ? `${key} ${documented[1]}%` : `nothing about ${key}`}. ` +
          `This assertion exists because these numbers were corrected once and drifted again.`,
      );
    }
  });

  it('STABILITY.md status stamp is within one minor of package.json', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    const [major, minor] = pkg.version.split('.').map(Number);
    assert.equal(typeof major, 'number');
    assert.equal(typeof minor, 'number');

    const stamp = read('STABILITY.md').match(/Honest status today \((\d+)\.(\d+) line\)/);
    assert.ok(stamp, 'STABILITY.md must carry a "Honest status today (X.Y line)" stamp');

    const drift = ((major as number) - Number(stamp[1])) * 1000 + ((minor as number) - Number(stamp[2]));
    assert.ok(
      drift <= 1 && drift >= -1,
      `STABILITY.md is stamped ${stamp[1]}.${stamp[2]} while package.json is at ${pkg.version}. ` +
        `Re-stamp the "Honest status today" heading and re-read the claims under it.`,
    );
  });

  it('CONTRIBUTING.md states the real error-code range', () => {
    const codes = Object.values(TurbineErrorCode).map((c) => Number(String(c).replace('TURBINE_E', '')));
    assert.ok(codes.length > 0 && codes.every(Number.isFinite), 'TurbineErrorCode must yield numeric codes');
    const highest = `E${String(Math.max(...codes)).padStart(3, '0')}`;

    const contributing = read('CONTRIBUTING.md');
    const documented = contributing.match(/E001\s*\D\s*(E\d{3})/);
    assert.ok(
      new RegExp(`E001[^)]*${highest}`).test(contributing),
      `CONTRIBUTING.md must name the highest code defined in src/errors.ts, ${highest}, but its range ends at ` +
        `${documented ? documented[1] : 'no code at all'}. ` +
        `Adding an error code without widening that range is how it came to claim E017 after E018 shipped.`,
    );
  });

  it('CONTRIBUTING.md states the real seeded user count', () => {
    const seed = read('src/test/fixtures/seed.sql');
    const start = seed.indexOf('INSERT INTO users');
    assert.notEqual(start, -1, 'seed.sql must contain an "INSERT INTO users" statement');

    // Only the value rows of THAT statement: slice at its terminating
    // semicolon so a later INSERT cannot inflate the count.
    const statement = seed.slice(start);
    const body = statement.slice(0, statement.indexOf(';'));
    const users = body.split('\n').filter((line) => /^\s*\(/.test(line)).length;
    assert.ok(users > 0, 'the seed-row parser found no value rows, so this assertion would pass vacuously');

    const contributing = read('CONTRIBUTING.md');
    const documented = contributing.match(/(\d+) users \/ \d+ posts/);
    assert.ok(
      new RegExp(`\\b${users} users\\b`).test(contributing),
      `src/test/fixtures/seed.sql seeds ${users} users; CONTRIBUTING.md says ` +
        `${documented ? `${documented[1]} users` : 'nothing about the seeded user count'}.`,
    );
  });

  it('CONTRIBUTING.md lists every query/ module', () => {
    const modules = readdirSync(new URL('src/query/', root)).filter((f) => f.endsWith('.ts'));
    assert.ok(modules.length > 0, 'no modules found under src/query/, so this assertion would pass vacuously');

    const contributing = read('CONTRIBUTING.md');
    const missing = modules.filter((m) => !contributing.includes(m));
    assert.deepEqual(
      missing,
      [],
      `CONTRIBUTING.md omits ${missing.length} of ${modules.length} query/ modules: ${missing.join(', ')}. ` +
        `The architecture block is the map new contributors read; a module missing from it is a module nobody finds.`,
    );
  });
});

/**
 * CLAUDE.md is the file every agent reads before its first edit, so a stale
 * number there is not a documentation defect, it is an instruction that
 * misdirects the next change. It carried four claims about the coverage
 * gates, a superlative about file size, and a release procedure that
 * `docs/WORKFLOW.md` had already retired, for several releases, while this
 * file guarded STABILITY.md and CONTRIBUTING.md and never read it.
 */
const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

/** `SEVEN` / `seven` / `7` -> 7. Asserts the token is a number at all. */
function countWord(token: string): number {
  if (/^\d+$/.test(token)) return Number(token);
  const n = NUMBER_WORDS.indexOf(token.toLowerCase());
  assert.notEqual(n, -1, `"${token}" is not a count this test can read; use a number word up to twelve or digits`);
  return n;
}

/** Newline count of every tracked-shape `.ts` file under src/, keyed by path relative to src/. */
function sourceLineCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rel of readdirSync(new URL('src/', root), { recursive: true, encoding: 'utf8' })) {
    // The Studio UI bundle is generated and gitignored: not "in the repo".
    if (!rel.endsWith('.ts') || rel.endsWith('.generated.ts')) continue;
    counts.set(rel, read(`src/${rel}`).split('\n').length);
  }
  assert.ok(counts.size > 50, `only ${counts.size} .ts files found under src/; the walk is broken`);
  return counts;
}

/**
 * Does this TypeScript source emit anything at runtime? A declaration-only
 * module (interfaces, type aliases, `import type`, `export type`) compiles to
 * `export {};`. Comments are stripped first so prose cannot trip the scan.
 */
function hasRuntimeCode(src: string): boolean {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  if (/^(?:export\s+)?(?:const|let|var|function|class|enum|async\s+function)\b/m.test(code)) return true;
  if (/^export\s+(?:default\b|\*\s+from)/m.test(code)) return true;
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    const specifiers = (m[1] as string)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (specifiers.some((s) => !s.startsWith('type '))) return true;
  }
  return false;
}

/** The path with the most lines among those whose relative path passes `where`. */
function largest(counts: Map<string, number>, where: (rel: string) => boolean): string {
  let best: [string, number] | undefined;
  for (const [rel, n] of counts) {
    if (where(rel) && (!best || n > best[1])) best = [rel, n];
  }
  assert.ok(best, 'no file matched the filter, so there is no largest file to compare against');
  return best[0];
}

describe('CLAUDE.md claims match their source of truth', () => {
  const claude = read('CLAUDE.md');
  const pkg = JSON.parse(read('package.json')) as {
    scripts: Record<string, string>;
    'lint-staged': Record<string, string | string[]>;
  };
  const c8 = JSON.parse(read('.c8rc.json')) as Record<string, unknown> & { exclude: string[] };

  it('quotes the real .c8rc.json coverage floors', () => {
    const m = claude.match(/Thresholds: (\d+)% lines, (\d+)% functions, (\d+)% branches, (\d+)% statements/);
    assert.ok(m, 'CLAUDE.md must carry a "Thresholds: N% lines, N% functions, N% branches, N% statements" sentence');
    const documented = {
      lines: Number(m[1]),
      functions: Number(m[2]),
      branches: Number(m[3]),
      statements: Number(m[4]),
    };
    for (const key of ['lines', 'functions', 'branches', 'statements'] as const) {
      assert.equal(typeof c8[key], 'number', `.c8rc.json must configure a numeric "${key}" threshold`);
      assert.equal(
        documented[key],
        c8[key],
        `CLAUDE.md says the coverage gate holds ${key} at ${documented[key]}%; .c8rc.json enforces ${c8[key] as number}%. ` +
          `An agent reading the lower number would treat a real regression as headroom.`,
      );
    }
  });

  it('names every .c8rc.json exclude entry in the Coverage paragraph and counts the type-only modules right', () => {
    assert.ok(Array.isArray(c8.exclude) && c8.exclude.length > 0, '.c8rc.json must have a non-empty exclude list');
    // The PARAGRAPH, not the whole file: `src/pg-types.ts` is named elsewhere
    // in CLAUDE.md for an unrelated reason, which is how a document-wide search
    // passed while the Coverage paragraph omitted it.
    const at = claude.indexOf('**Coverage** is configured in');
    assert.notEqual(at, -1, 'CLAUDE.md must have a paragraph starting "**Coverage** is configured in"');
    const paragraph = claude.slice(at, claude.indexOf('\n\n', at));
    const unmentioned = c8.exclude.filter((entry) => !paragraph.includes(`\`${entry}\``));
    assert.deepEqual(
      unmentioned,
      [],
      `.c8rc.json excludes ${unmentioned.join(', ')} from coverage and CLAUDE.md's Coverage paragraph does not say so.`,
    );

    const m = paragraph.match(/the (\w+) type-only modules that emit no runtime code \(([^)]*)\)/);
    assert.ok(m, 'the Coverage paragraph must carry "the N type-only modules that emit no runtime code (...)"');
    const listed = [...(m[2] as string).matchAll(/`(src\/[\w./-]+\.ts)`/g)].map((x) => x[1] as string);
    assert.ok(listed.length > 0, 'the type-only parenthetical names no files; the regex matched the wrong sentence');
    assert.equal(
      countWord(m[1] as string),
      listed.length,
      `CLAUDE.md says "${m[1]} type-only modules" and then lists ${listed.length}: ${listed.join(', ')}.`,
    );

    // "Type-only" is a claim about the FILES, checked against them: a single
    // `.ts` exclude entry that compiles to `export {};` must be in the list,
    // and nothing in the list may carry runtime code.
    assert.ok(
      hasRuntimeCode(read('src/query/utils.ts')),
      'the runtime-code scanner must flag query/utils.ts, or it flags nothing',
    );
    const typeOnlyExcludes = c8.exclude.filter((e) => e.endsWith('.ts') && !hasRuntimeCode(read(e)));
    assert.ok(
      typeOnlyExcludes.length > 0,
      '.c8rc.json excludes no type-only file, so the count below would be vacuous',
    );
    assert.deepEqual(
      [...listed].sort(),
      [...typeOnlyExcludes].sort(),
      `CLAUDE.md's type-only list is ${listed.join(', ')}; the type-only files .c8rc.json excludes are ${typeOnlyExcludes.join(', ')}.`,
    );
  });

  it('CLI coverage gate: the file count and the file list match the coverage:cli:gate:* scripts', () => {
    const perFile = Object.entries(pkg.scripts).filter(
      ([name]) => name.startsWith('coverage:cli:gate:') && name !== 'coverage:cli:gate:aggregate',
    );
    assert.ok(perFile.length > 0, 'no coverage:cli:gate:<file> scripts found in package.json');
    const gated = perFile.map(([name, cmd]) => {
      const includes = [...cmd.matchAll(/--include (src\/cli\/[\w-]+\.ts)/g)].map((x) => x[1] as string);
      assert.equal(includes.length, 1, `${name} must gate exactly one file, found ${includes.length}`);
      return (includes[0] as string).replace(/^src\//, '');
    });

    const m = claude.match(/over (\w+) files: (.*?), each with its own floor/s);
    assert.ok(
      m,
      'CLAUDE.md must carry "over N files: `cli/a.ts`, ... each with its own floor" in the Coverage paragraph',
    );
    assert.equal(
      countWord(m[1] as string),
      gated.length,
      `CLAUDE.md says the CLI coverage gate holds ${m[1]} files; package.json has ${gated.length} per-file gates: ${gated.join(', ')}.`,
    );
    const unnamed = gated.filter((file) => !(m[2] as string).includes(`\`${file}\``));
    assert.deepEqual(unnamed, [], `CLAUDE.md's CLI gate file list omits ${unnamed.join(', ')}`);
  });

  it('a "largest file" superlative names the file that actually is', () => {
    const counts = sourceLineCounts();
    const sentenceAround = (index: number): string => {
      const from = claude.lastIndexOf('. ', index) + 1;
      const to = claude.indexOf('.', index);
      return claude.slice(from === 0 ? 0 : from, to === -1 ? undefined : to);
    };

    const inRepo = largest(counts, () => true);
    for (const m of claude.matchAll(/largest file in the repo/g)) {
      const sentence = sentenceAround(m.index);
      assert.ok(
        sentence.includes(`\`${inRepo}\``) || sentence.includes(`\`src/${inRepo}\``),
        `CLAUDE.md claims a file is "the largest file in the repo"; by line count that is src/${inRepo}. Sentence: ${sentence.trim()}`,
      );
    }

    // The claim CLAUDE.md does make, and the one this test would pass vacuously
    // without: the NUL-byte rule says which file under src/query/ is largest.
    const inQuery = largest(counts, (rel) => rel.startsWith('query/'));
    const claims = [...claude.matchAll(/largest file under `src\/query\/`/g)];
    assert.ok(
      claims.length > 0,
      'CLAUDE.md must still state which file is the largest under src/query/ (the NUL-byte rule)',
    );
    for (const m of claims) {
      const sentence = sentenceAround(m.index);
      assert.ok(
        sentence.includes(`\`${inQuery}\``),
        `CLAUDE.md's "largest file under src/query/" sentence must name ${inQuery}. Sentence: ${sentence.trim()}`,
      );
    }
  });

  it('describes the tag as what publishes, never a local npm publish plus a manual site deploy', () => {
    assert.match(
      claude,
      /The tag publishes, not `npm publish`/,
      'the release rule at the top of CLAUDE.md is the anchor',
    );
    assert.doesNotMatch(
      claude,
      /`npm publish` \+ `vercel --prod`|vercel --prod/,
      'CLAUDE.md still describes the release as a local `npm publish` plus `vercel --prod`; the tag publishes and the site deploys from main',
    );
  });

  it('the pii JSDoc describes the UNSAFE sentinel, and CLAUDE.md no longer says it is stale', () => {
    for (const file of ['src/schema.ts', 'src/schema-builder.ts']) {
      const src = read(file);
      const at = src.indexOf('pii?: boolean;');
      assert.notEqual(at, -1, `${file} must declare \`pii?: boolean\``);
      const block = src.slice(src.lastIndexOf('/**', at), at);
      assert.match(
        block,
        /includePii: UNSAFE/,
        `${file}'s pii JSDoc must describe the UNSAFE sentinel, not a boolean opt-in`,
      );
    }
    assert.doesNotMatch(
      claude,
      /still describe the old boolean form/,
      'CLAUDE.md says two JSDoc blocks still describe the old boolean `includePii`; they describe the sentinel. Delete the sentence.',
    );
  });
});

describe('the pre-commit hook and CI run the linter with the same flags', () => {
  it('every flag in scripts.lint appears in the lint-staged command', () => {
    // `lint` is what CI runs; lint-staged is what the hook runs on the staged
    // files. A flag present in one and absent from the other is a class of
    // finding the hook waves through and CI rejects, discovered one push later.
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
      'lint-staged': Record<string, string | string[]>;
    };
    const lint = pkg.scripts.lint ?? '';
    assert.ok(lint.startsWith('biome check '), `scripts.lint must be a \`biome check\` invocation, got "${lint}"`);
    const flags = lint.split(/\s+/).filter((tok) => tok.startsWith('--'));
    assert.ok(flags.length > 0, 'scripts.lint carries no flags, so this assertion would pass vacuously');

    const stagedRaw = pkg['lint-staged']?.['*.ts'];
    const staged = (Array.isArray(stagedRaw) ? stagedRaw : [stagedRaw ?? '']).join(' && ');
    assert.match(staged, /biome check/, 'lint-staged must run `biome check` on *.ts');
    const missing = flags.filter((flag) => !staged.split(/\s+/).includes(flag));
    assert.deepEqual(
      missing,
      [],
      `scripts.lint passes ${missing.join(' ')} and the lint-staged command does not, so the hook accepts what CI refuses.`,
    );
  });
});
