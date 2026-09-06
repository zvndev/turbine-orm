import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Every relative import in a docs TypeScript snippet carries a file extension.
 *
 * The README explains that `./generated/turbine/index.js` needs its `/index.js`
 * under `moduleResolution: NodeNext` (a relative specifier has no directory
 * index and no extension search there), and the quickstart sets projects up as
 * `"type": "module"`, which is that resolution. Docs snippets still wrote
 * `from './generated/turbine/metadata'`, which is `TS2834` for exactly the
 * reader the quickstart produced (twelve, counting every page). The bundler pages (`moduleResolution:
 * bundler` accepts either spelling) were half of them, and there the
 * extensionless form is merely one of two that work, while the `.js` form works
 * everywhere, so the docs carry the form that compiles under both.
 *
 * This walks every `.mdx` page under `site/app` AND every `.md` file under
 * `docs/`, pulls out the fenced `ts` / `tsx` / `typescript` blocks, and fails
 * on a relative specifier with no extension, naming the page, line and
 * specifier.
 *
 * `docs/` was outside the walk when this guard was written, and it held four
 * more of exactly the offender the guard exists to catch. A reader copying from
 * a tracked markdown file has the same compile error as one copying from the
 * site, so the two surfaces belong in one sweep rather than one guard and one
 * blind spot. The scan counts are asserted
 * too: a walker that finds no fences, or a specifier regex that matches no
 * imports, would pass while checking nothing, which is how the previous sync
 * tests came to guard numbers nobody read.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SITE_APP = join(ROOT, 'site', 'app');
const DOCS = join(ROOT, 'docs');

/** Fence languages that are TypeScript modules, i.e. where a bare specifier is a compile error. */
const TS_FENCE_LANGS = new Set(['ts', 'tsx', 'typescript']);

/**
 * Extensions a relative specifier may end in. `.js` is the NodeNext spelling of
 * a TypeScript sibling; `.mjs` / `.cjs` name a format explicitly; `.json` is a
 * JSON module. `.ts` is deliberately NOT here: importing `./schema.ts` needs
 * `allowImportingTsExtensions`, which the quickstart's tsconfig does not set.
 */
const ALLOWED_EXTENSIONS = /\.(js|mjs|cjs|json)$/;

/** Floors sit well under the real counts (290 fences, 33 relative imports when this was written). */
const MIN_FENCES = 100;
const MIN_RELATIVE_IMPORTS = 10;

interface Offender {
  file: string;
  line: number;
  specifier: string;
}

interface ScanResult {
  fences: number;
  relativeImports: number;
  offenders: Offender[];
}

function walkMdx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      walkMdx(full, out);
    } else if (entry.endsWith('.mdx') || entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The specifier shapes a TypeScript module can import from:
 *   `import x from './a'`, `import { x } from './a'`, `export { x } from './a'`,
 *   `import './a'` (side-effect), and `import('./a')` (dynamic).
 */
const SPECIFIER_PATTERNS: RegExp[] = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /^\s*import\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function specifiersIn(line: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of line.matchAll(pattern)) found.push(m[1]!);
  }
  return found;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

export function scanDocsSnippets(files: string[]): ScanResult {
  const result: ScanResult = { fences: 0, relativeImports: 0, offenders: [] };
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    let inFence = false;
    let tsFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith('```')) {
        if (!inFence) {
          inFence = true;
          // ```ts, ```ts title="x", ```tsx: the language is the first word after the ticks.
          const lang = line.slice(3).trim().split(/\s+/)[0] ?? '';
          tsFence = TS_FENCE_LANGS.has(lang);
          if (tsFence) result.fences++;
        } else {
          inFence = false;
          tsFence = false;
        }
        continue;
      }
      if (!inFence || !tsFence) continue;
      for (const specifier of specifiersIn(line)) {
        if (!isRelative(specifier)) continue;
        result.relativeImports++;
        if (!ALLOWED_EXTENSIONS.test(specifier)) {
          result.offenders.push({ file: relative(ROOT, file), line: i + 1, specifier });
        }
      }
    }
  }
  return result;
}

describe('docs snippets: relative imports carry an extension', () => {
  // `docs/internal/` is gitignored working material, not a published surface.
  const files = [...walkMdx(SITE_APP), ...walkMdx(DOCS).filter((f) => !f.includes(`${sep}internal${sep}`))];
  const scan = scanDocsSnippets(files);

  it('scanned a real number of TypeScript fences and relative imports', () => {
    assert.ok(files.length > 0, `no docs files found under ${SITE_APP} or ${DOCS}`);
    assert.ok(
      scan.fences >= MIN_FENCES,
      `expected at least ${MIN_FENCES} ts/tsx/typescript fences under site/app, scanned ${scan.fences}; ` +
        'the fence scanner has stopped recognising the docs, so the assertion below is checking nothing',
    );
    assert.ok(
      scan.relativeImports >= MIN_RELATIVE_IMPORTS,
      `expected at least ${MIN_RELATIVE_IMPORTS} relative import specifiers in docs snippets, found ` +
        `${scan.relativeImports}; the specifier regexes have stopped matching, so the assertion below is checking nothing`,
    );
  });

  it('every relative import specifier in a ts/tsx fence ends in .js, .mjs, .cjs or .json', () => {
    const lines = scan.offenders.map((o) => `  ${o.file}:${o.line}  '${o.specifier}'`);
    assert.equal(
      scan.offenders.length,
      0,
      `${scan.offenders.length} docs snippet import(s) have no file extension and fail under ` +
        `moduleResolution: NodeNext (TS2834). Append .js:\n${lines.join('\n')}`,
    );
  });

  it('the scanner itself flags an extensionless specifier and accepts the .js form', () => {
    // A self-check on the regexes, so a future edit to SPECIFIER_PATTERNS that
    // stops matching cannot turn the suite green by matching nothing.
    const flagged = specifiersIn("import { SCHEMA } from './generated/turbine/metadata';");
    assert.deepEqual(flagged, ['./generated/turbine/metadata']);
    assert.ok(!ALLOWED_EXTENSIONS.test(flagged[0]!));
    assert.ok(ALLOWED_EXTENSIONS.test('./generated/turbine/metadata.js'));
    assert.deepEqual(specifiersIn("import schema from './turbine/schema';"), ['./turbine/schema']);
    assert.deepEqual(specifiersIn("const m = await import('./x');"), ['./x']);
    assert.deepEqual(specifiersIn("import './setup';"), ['./setup']);
    assert.deepEqual(specifiersIn("import { Pool } from 'pg';"), ['pg']);
    assert.ok(!isRelative('pg'));
    assert.ok(!isRelative('turbine-orm/serverless'));
  });
});
