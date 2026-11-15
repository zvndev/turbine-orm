#!/usr/bin/env tsx
/**
 * The engine and version support matrix: one data file, two rendered outputs.
 *
 *   docs/engine-support.json            the source of truth (hand-edited)
 *   docs/engine-support.md              rendered from it
 *   site/lib/engine-support.generated.ts rendered from it, for the engines page
 *
 * A route's tier is never written down. It is computed from its core feature
 * cells by the rule in `earnedTier`, so a tier cannot be raised without
 * raising the evidence that earns it.
 *
 * The evidence is checked against the repository, not trusted:
 *   - every package.json export belongs to a route or is named as not an engine;
 *   - a `ci-native` evidence entry names jobs that exist in gates.yml, each of
 *     its files is run by one of those jobs (named in the job, reached through
 *     an npm script or a `via` runner, or matched by the job's test glob), and
 *     its requirement guard appears in the job or the runner, so a suite that
 *     would skip cannot be counted as run;
 *   - every version a route says CI exercises carries `pins`, literal text that
 *     must appear in that job, so a changed image or Node matrix fails until the
 *     page says what CI now runs.
 *
 *   npx tsx scripts/gen-engine-support.ts           write both outputs
 *   npx tsx scripts/gen-engine-support.ts --check   exit 1 if invalid or stale
 *
 * `--check` runs in the unit suite (src/test/engine-support-matrix.test.ts).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'docs', 'engine-support.json');
const DOC = join(ROOT, 'docs', 'engine-support.md');
const SITE = join(ROOT, 'site', 'lib', 'engine-support.generated.ts');

export type CellValue = 'yes' | 'partial' | 'no';
export type EvidenceClass = 'ci-native' | 'local-native' | 'mock' | 'none';
export type Tier = 'Supported' | 'Preview' | 'Experimental' | 'Deferred' | 'Maintenance' | 'Not supported';
type EarnedTier = 'Supported' | 'Preview' | 'Experimental';

export interface Evidence {
  class: Exclude<EvidenceClass, 'none'>;
  summary: string;
  files: string[];
  /** gates.yml jobs that run the files (`ci-native` only). */
  jobs?: string[];
  /** Runner files a job invokes that in turn name the test files. */
  via?: string[];
  /** Literal text in the job or a runner that makes a skipped suite fail. */
  guard?: string;
  /** Why no guard is needed (the suite cannot skip). */
  noSkip?: string;
  /** Literal text every file must contain (a native gate, not a mock). */
  marker?: string;
  /** How to run a `local-native` suite. */
  command?: string;
  /** nightly.yml jobs that run a `local-native` suite on a schedule. */
  scheduledJobs?: string[];
}

export interface Cell {
  value: CellValue;
  evidence?: string;
  note?: string;
}

export interface CiVersion {
  job: string;
  text: string;
  pins: string[];
}

export interface Route {
  id: string;
  label: string;
  exports: string[];
  driver: string;
  status: 'active' | 'deferred' | 'maintenance' | 'refused';
  summary: string;
  versions: { ci: CiVersion[]; drivers: string[]; local: string[]; untested: string[] };
  evidence: Record<string, Evidence>;
  cells: Record<string, Cell>;
  limitations: string[];
}

export interface Feature {
  id: string;
  label: string;
  core: boolean;
}

export interface SupportData {
  asOf: string;
  source: string;
  features: Feature[];
  nonEngineExports: Record<string, string>;
  routes: Route[];
}

export interface RepoContext {
  exports: string[];
  scripts: Record<string, string>;
  gatesJobs: Map<string, string>;
  nightlyJobs: Map<string, string>;
  readFile(path: string): string | undefined;
}

export function loadData(): SupportData {
  return JSON.parse(readFileSync(DATA, 'utf-8')) as SupportData;
}

/** Job name to the text of its block, for the jobs under `jobs:` in a workflow. */
export function workflowJobs(text: string): Map<string, string> {
  const jobs = new Map<string, string>();
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === 'jobs:');
  let name: string | undefined;
  let body: string[] = [];
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    const header = /^ {2}([a-z0-9][a-z0-9_-]*):\s*$/.exec(line);
    if (header || /^\S/.test(line)) {
      if (name) jobs.set(name, body.join('\n'));
      name = header?.[1];
      body = [];
      if (!header) break;
      continue;
    }
    body.push(line);
  }
  if (name) jobs.set(name, body.join('\n'));
  return jobs;
}

export function readContext(): RepoContext {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
    exports: Record<string, unknown>;
    scripts: Record<string, string>;
  };
  const workflow = (file: string) => workflowJobs(readFileSync(join(ROOT, '.github', 'workflows', file), 'utf-8'));
  return {
    exports: Object.keys(pkg.exports),
    scripts: pkg.scripts,
    gatesJobs: workflow('gates.yml'),
    nightlyJobs: workflow('nightly.yml'),
    readFile: (path) => {
      const full = join(ROOT, path);
      return existsSync(full) ? readFileSync(full, 'utf-8') : undefined;
    },
  };
}

function globMatches(pattern: string, file: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${source}$`).test(file);
}

/** The command text a job runs, with `npm test` / `npm run x` expanded from package.json. */
function expandedCommands(text: string, scripts: Record<string, string>, depth = 0): string {
  if (depth > 3) return text;
  const expansions: string[] = [];
  for (const match of text.matchAll(/\bnpm (?:test\b|run ([\w:.-]+))(?![^\n]*--prefix)/g)) {
    const script = scripts[match[1] ?? 'test'];
    if (script) expansions.push(expandedCommands(script, scripts, depth + 1));
  }
  return [text, ...expansions].join('\n');
}

/** Whether a command text runs `file`, by name or by a `src/test/...*` glob token. */
function commandsRun(commands: string, file: string): boolean {
  if (commands.includes(file)) return true;
  for (const token of commands.match(/src\/test\/[\w.*/-]*\*[\w.*/-]*/g) ?? []) {
    if (globMatches(token, file)) return true;
  }
  return false;
}

export function jobRunsFile(ctx: RepoContext, job: string, file: string, via: readonly string[] = []): boolean {
  const text = ctx.gatesJobs.get(job);
  if (text === undefined) return false;
  const commands = expandedCommands(text, ctx.scripts);
  if (commandsRun(commands, file)) return true;
  return via.some((runner) => commandsRun(commands, runner) && (ctx.readFile(runner) ?? '').includes(file));
}

const VALUES: readonly CellValue[] = ['yes', 'partial', 'no'];
const CLASSES: readonly EvidenceClass[] = ['ci-native', 'local-native', 'mock', 'none'];
const STATUSES: readonly Route['status'][] = ['active', 'deferred', 'maintenance', 'refused'];

export function cellClass(route: Route, featureId: string): EvidenceClass {
  const ref = route.cells[featureId]?.evidence;
  return ref ? (route.evidence[ref]?.class ?? 'none') : 'none';
}

/**
 * The tier rule, applied to the core feature rows only:
 *   Supported    every core row is yes or partial, each with ci-native evidence;
 *   Preview      every core row is yes or partial, each with at least local-native evidence;
 *   Experimental anything else (a core row is no, or rests on mock or no evidence).
 */
export function earnedTier(data: SupportData, route: Route): EarnedTier {
  const core = data.features.filter((f) => f.core);
  if (core.some((f) => route.cells[f.id]?.value === 'no')) return 'Experimental';
  const classes = core.map((f) => cellClass(route, f.id));
  if (classes.every((c) => c === 'ci-native')) return 'Supported';
  if (classes.every((c) => c === 'ci-native' || c === 'local-native')) return 'Preview';
  return 'Experimental';
}

export function routeTier(data: SupportData, route: Route): Tier {
  if (route.status === 'deferred') return 'Deferred';
  if (route.status === 'maintenance') return 'Maintenance';
  if (route.status === 'refused') return 'Not supported';
  return earnedTier(data, route);
}

/** What the evidence earns, for display: a refused target earns nothing. */
export function earnedLabel(data: SupportData, route: Route): string {
  return route.status === 'refused' ? 'n/a' : earnedTier(data, route);
}

/** The core rows that keep a route below Supported, with what each lacks. */
export function supportedGaps(data: SupportData, route: Route): string[] {
  return data.features
    .filter((f) => f.core)
    .flatMap((f) => {
      const cell = route.cells[f.id];
      const cls = cellClass(route, f.id);
      if (cell?.value === 'no') return [`${f.label}: not available on this route`];
      if (cls !== 'ci-native') return [`${f.label}: evidence is ${cls}, needs ci-native`];
      return [];
    });
}

function eachString(value: unknown, visit: (s: string, path: string) => void, path = '$'): void {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value)) value.forEach((v, i) => eachString(v, visit, `${path}[${i}]`));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      visit(k, `${path}.${k}`);
      eachString(v, visit, `${path}.${k}`);
    }
}

/** Every problem with the data, as messages naming the route and field. Empty means valid. */
export function validate(data: SupportData, ctx: RepoContext): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(message);

  eachString(data, (s, path) => {
    if (s.includes('—')) fail(`${path}: contains an em-dash; use a comma, colon or new sentence`);
  });

  const featureIds = new Set<string>();
  for (const f of data.features) {
    if (featureIds.has(f.id)) fail(`feature ${f.id} is listed twice`);
    featureIds.add(f.id);
  }
  if (!data.features.some((f) => f.core)) fail('no feature is marked core, so every tier would be vacuous');

  const claimed = new Set<string>();
  const routeIds = new Set<string>();
  for (const route of data.routes) {
    const where = `route ${route.id}`;
    if (routeIds.has(route.id)) fail(`${where} is listed twice`);
    routeIds.add(route.id);
    if (!STATUSES.includes(route.status)) fail(`${where}: unknown status ${route.status}`);
    if (route.exports.length === 0) fail(`${where}: names no package export`);
    for (const exp of route.exports) {
      if (!ctx.exports.includes(exp)) fail(`${where}: export ${exp} is not in package.json exports`);
      claimed.add(exp);
    }

    for (const v of route.versions.ci) {
      const text = ctx.gatesJobs.get(v.job);
      if (text === undefined) {
        fail(`${where}: CI version "${v.text}" cites job ${v.job}, which gates.yml does not define`);
        continue;
      }
      if (v.pins.length === 0) fail(`${where}: CI version "${v.text}" has no pins to check against ${v.job}`);
      for (const pin of v.pins)
        if (!text.includes(pin)) fail(`${where}: CI version "${v.text}" pins "${pin}", not found in job ${v.job}`);
    }

    for (const [id, ev] of Object.entries(route.evidence)) {
      const at = `${where} evidence ${id}`;
      if (!CLASSES.includes(ev.class) || ev.class === ('none' as string))
        fail(`${at}: class must be ci-native, local-native or mock`);
      if (ev.files.length === 0) fail(`${at}: names no file`);
      for (const file of [...ev.files, ...(ev.via ?? [])]) {
        const content = ctx.readFile(file);
        if (content === undefined) {
          fail(`${at}: file ${file} does not exist`);
          continue;
        }
        if (ev.marker && ev.files.includes(file) && !content.includes(ev.marker))
          fail(`${at}: file ${file} does not contain its native marker "${ev.marker}"`);
      }
      if (ev.class === 'ci-native') {
        if (!ev.jobs?.length) fail(`${at}: ci-native evidence names no gates.yml job`);
        for (const job of ev.jobs ?? []) {
          if (!ctx.gatesJobs.has(job)) fail(`${at}: job ${job} is not defined in gates.yml`);
        }
        for (const file of ev.files) {
          if (!(ev.jobs ?? []).some((job) => jobRunsFile(ctx, job, file, ev.via)))
            fail(`${at}: no listed job (${(ev.jobs ?? []).join(', ')}) runs ${file}`);
        }
        if (!ev.guard && !ev.noSkip) fail(`${at}: ci-native evidence needs a guard or a noSkip reason`);
        if (ev.guard) {
          const sources = [
            ...(ev.jobs ?? []).map((job) => ctx.gatesJobs.get(job) ?? ''),
            ...(ev.via ?? []).map((runner) => ctx.readFile(runner) ?? ''),
          ];
          if (!sources.some((text) => text.includes(ev.guard!)))
            fail(`${at}: guard "${ev.guard}" appears in none of its jobs or runners`);
        }
      } else {
        if (ev.jobs?.length) fail(`${at}: only ci-native evidence may name gates.yml jobs`);
        if (ev.class === 'local-native' && !ev.command) fail(`${at}: local-native evidence needs a command`);
        for (const job of ev.scheduledJobs ?? [])
          if (!ctx.nightlyJobs.has(job)) fail(`${at}: scheduled job ${job} is not defined in nightly.yml`);
      }
    }

    for (const f of data.features) {
      const cell = route.cells[f.id];
      if (!cell) {
        fail(`${where}: no cell for feature ${f.id}`);
        continue;
      }
      if (!VALUES.includes(cell.value)) fail(`${where} ${f.id}: value must be yes, partial or no`);
      if (cell.evidence !== undefined && !route.evidence[cell.evidence])
        fail(`${where} ${f.id}: evidence ${cell.evidence} is not defined on this route`);
      if (cell.value !== 'yes' && !cell.note) fail(`${where} ${f.id}: a ${cell.value} cell needs a note`);
    }
    for (const id of Object.keys(route.cells)) if (!featureIds.has(id)) fail(`${where}: unknown feature ${id}`);
  }

  for (const [exp, reason] of Object.entries(data.nonEngineExports)) {
    if (!ctx.exports.includes(exp)) fail(`non-engine export ${exp} is not in package.json exports`);
    if (claimed.has(exp)) fail(`export ${exp} is both a route and a non-engine export`);
    if (!reason) fail(`non-engine export ${exp} needs a reason`);
  }
  for (const exp of ctx.exports) {
    if (!claimed.has(exp) && !(exp in data.nonEngineExports))
      fail(`package.json export ${exp} has no matrix route and is not listed as a non-engine export`);
  }
  return problems;
}

function cellText(text: string): string {
  // Backslash first, so an existing backslash cannot turn the pipe escape
  // that follows it into a literal pipe again.
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function importList(route: Route): string {
  return route.exports.map((e) => `\`${e === '.' ? 'turbine-orm' : `turbine-orm/${e.slice(2)}`}\``).join(', ');
}

const VALUE_MARK: Record<CellValue, string> = { yes: 'yes', partial: 'partial', no: 'no' };

export function renderMarkdown(data: SupportData): string {
  const core = data.features.filter((f) => f.core);
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);

  push(
    '<!-- Generated by scripts/gen-engine-support.ts from docs/engine-support.json. Do not edit:',
    '     run `npm run gen:engine-support`. The unit suite fails while this file is stale. -->',
    '',
    '# Engine and version support',
    '',
    `As of ${data.asOf}. ${data.source}`,
    '',
    'This page says, for every engine and transport the package exposes, what works, on which versions, and how',
    'that is known. Each claim names its evidence, and each tier is computed from that evidence by the rule',
    'below, not chosen. A unit test checks the evidence against the repository: the CI jobs it names exist, run',
    'the files it names, and fail rather than skip when the engine is missing.',
    '',
    'An evidence class describes how a check is wired, not the outcome of a particular run. Check the CI status',
    'of the commit you install.',
    '',
    '## Evidence classes',
    '',
    '| Class | Meaning |',
    '| --- | --- |',
    '| `ci-native` | A job in `.github/workflows/gates.yml` runs the suite against the real engine or driver on every pull request and every release tag, with a guard that turns a skipped suite into a failure. |',
    '| `local-native` | A suite runs against the real engine, but only on a developer machine or in a scheduled job outside the release gates. |',
    '| `mock` | Unit tests over generated SQL, a recording pool or a fake driver. They show what Turbine sends, not what the engine does with it. |',
    '| `none` | No test exercises this on this route. A `yes` with `none` is implemented and unqualified. |',
    '',
    '## Tiers',
    '',
    `The rule reads the core rows only: ${core.map((f) => f.label).join('; ')}.`,
    '',
    '| Tier | Rule |',
    '| --- | --- |',
    '| Supported | Every core row is `yes` or `partial`, and each has `ci-native` evidence. |',
    '| Preview | Every core row is `yes` or `partial`, and each has at least `local-native` evidence. |',
    '| Experimental | Anything else: a core row is `no`, or rests on `mock` or no evidence. |',
    '| Deferred | Not being worked on. No promise is made. The evidence that exists is shown for information. |',
    '| Maintenance | Bug and data-safety fixes only, no new features. |',
    '| Not supported | Turbine refuses this target. |',
    '',
    'A tier applies to the versions listed under "Tested in CI" for that route. Anything outside them is listed',
    'as not tested.',
    '',
    'These tiers grade test evidence. [STABILITY.md](../STABILITY.md) separately says which APIs may change in a',
    'minor release. The two are independent: a route can be Supported here while its API is still Experimental',
    'there.',
    '',
    '## Summary',
    '',
    '| Route | Import | Tier | Evidence alone earns | Tested in CI on |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const route of data.routes) {
    const tier = routeTier(data, route);
    const earned = earnedLabel(data, route);
    const ci = route.versions.ci.length ? route.versions.ci.map((v) => v.text).join('<br>') : 'nothing';
    push(`| [${route.label}](#${route.id}) | ${importList(route)} | **${tier}** | ${earned} | ${cellText(ci)} |`);
  }

  push('', '## Core rows by route', '', `| Route | ${core.map((f) => f.label).join(' | ')} |`);
  push(`| --- | ${core.map(() => '---').join(' | ')} |`);
  for (const route of data.routes) {
    const cells = core.map((f) => `${VALUE_MARK[route.cells[f.id]!.value]}, ${cellClass(route, f.id)}`);
    push(`| ${route.label} | ${cells.join(' | ')} |`);
  }

  for (const route of data.routes) {
    const tier = routeTier(data, route);
    const earned = earnedLabel(data, route);
    push('', `<a id="${route.id}"></a>`, '', `## ${route.label}`, '');
    push(`**${tier}.** ${route.summary}`, '');
    push(`- Import: ${importList(route)}`, `- Driver: ${route.driver}`);
    if (route.status !== 'refused' && tier !== earned) push(`- Evidence alone would earn: ${earned}`);
    const gaps = supportedGaps(data, route);
    if (route.status !== 'refused' && gaps.length) {
      push('', 'What Supported still needs:', '');
      for (const gap of gaps) push(`- ${gap}`);
    }
    push('', '### Versions', '');
    push('Tested in CI:', '');
    if (route.versions.ci.length === 0) push('- Nothing.');
    for (const v of route.versions.ci) push(`- ${v.text} (job \`${v.job}\`)`);
    if (route.versions.drivers.length) {
      push('', 'Drivers:', '');
      for (const d of route.versions.drivers) push(`- ${d}`);
    }
    if (route.versions.local.length) {
      push('', 'Outside CI:', '');
      for (const l of route.versions.local) push(`- ${l}`);
    }
    if (route.versions.untested.length) {
      push('', 'Not tested:', '');
      for (const u of route.versions.untested) push(`- ${u}`);
    }
    push('', '### Features', '', '| Feature | Support | Evidence | Note |', '| --- | --- | --- | --- |');
    for (const f of data.features) {
      const cell = route.cells[f.id]!;
      const label = f.core ? `${f.label} (core)` : f.label;
      const ref = cell.evidence ? ` ([${cell.evidence}](#${route.id}-${cell.evidence}))` : '';
      push(`| ${label} | ${cell.value} | ${cellClass(route, f.id)}${ref} | ${cellText(cell.note ?? '')} |`);
    }
    const entries = Object.entries(route.evidence);
    if (entries.length) {
      push('', '### Evidence', '');
      for (const [id, ev] of entries) {
        const where =
          ev.class === 'ci-native'
            ? `jobs ${(ev.jobs ?? []).map((j) => `\`${j}\``).join(', ')}`
            : ev.command
              ? `\`${ev.command}\``
              : 'unit suite';
        const scheduled = ev.scheduledJobs?.length
          ? `; scheduled in nightly.yml: ${ev.scheduledJobs.map((j) => `\`${j}\``).join(', ')}`
          : '';
        const guard = ev.guard ? `; guard \`${ev.guard}\`` : '';
        push(
          `- <a id="${route.id}-${id}"></a>**${id}** (${ev.class}, ${where}${scheduled}${guard}): ${ev.summary}`,
          `  Files: ${[...ev.files, ...(ev.via ?? [])].map((f) => `\`${f}\``).join(', ')}`,
        );
      }
    }
    if (route.limitations.length) {
      push('', '### Known limitations', '');
      for (const l of route.limitations) push(`- ${l}`);
    }
  }

  push('', '## Exports that are not engine routes', '', '| Import | Why it has no row |', '| --- | --- |');
  for (const [exp, reason] of Object.entries(data.nonEngineExports))
    push(`| \`turbine-orm/${exp.slice(2)}\` | ${cellText(reason)} |`);
  push('');
  return out.join('\n');
}

export function renderSite(data: SupportData): string {
  const rows = data.routes.map((route) => {
    const imports = route.exports.map((e) => (e === '.' ? 'turbine-orm' : `turbine-orm/${e.slice(2)}`));
    return `  { id: ${JSON.stringify(route.id)}, label: ${JSON.stringify(route.label)}, imports: ${JSON.stringify(imports)}, tier: ${JSON.stringify(routeTier(data, route))}, earned: ${JSON.stringify(earnedLabel(data, route))}, ci: ${JSON.stringify(route.versions.ci.map((v) => v.text))} },`;
  });
  return [
    '// Generated by scripts/gen-engine-support.ts from docs/engine-support.json. Do not edit:',
    '// run `npm run gen:engine-support`. The unit suite fails while this file is stale.',
    '',
    `export const ENGINE_SUPPORT_AS_OF = ${JSON.stringify(data.asOf)};`,
    '',
    'export interface EngineSupportRow {',
    '  id: string;',
    '  label: string;',
    '  imports: string[];',
    '  tier: string;',
    '  earned: string;',
    '  ci: string[];',
    '}',
    '',
    'export const ENGINE_SUPPORT_ROWS: readonly EngineSupportRow[] = [',
    ...rows,
    '];',
    '',
  ].join('\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const data = loadData();
  const problems = validate(data, readContext());
  if (problems.length) {
    console.error(`docs/engine-support.json has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  const outputs: Array<[string, string]> = [
    [DOC, renderMarkdown(data)],
    [SITE, renderSite(data)],
  ];
  if (process.argv.includes('--check')) {
    const stale = outputs.filter(([path, next]) => !existsSync(path) || readFileSync(path, 'utf-8') !== next);
    if (stale.length) {
      console.error(
        `${stale.map(([p]) => p.slice(ROOT.length + 1)).join(' and ')} stale. Run: npm run gen:engine-support`,
      );
      process.exit(1);
    }
    console.log('docs/engine-support.md and site/lib/engine-support.generated.ts are current.');
  } else {
    for (const [path, next] of outputs) {
      writeFileSync(path, next);
      console.log(`wrote ${path}`);
    }
  }
}
