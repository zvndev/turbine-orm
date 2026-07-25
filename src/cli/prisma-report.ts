/**
 * Render a {@link ResolutionResult} into the `prisma-migration-report.md`
 * artifact and a short console summary. Pure leaf - string in, string out.
 */

import type { ResolutionResult, ResolvedModel } from './prisma-resolve.js';

export interface ReportOptions {
  /** Path the Prisma schema was read from (for the report header). */
  schemaPath?: string;
  /** Omit the volatile `Generated: <ISO>` line for reproducible output. */
  noTimestamp?: boolean;
}

const CHECK = 'OK';
const CROSS = 'UNRESOLVED';

function modelDisplayStatus(m: ResolvedModel): string {
  if (m.status === 'parsed') return 'parsed';
  if (m.status === 'unresolved') return CROSS;
  return m.viaMap ? `${CHECK} (@@map)` : CHECK;
}

/**
 * Build the full Markdown migration report.
 */
export function formatPrismaReport(result: ResolutionResult, options: ReportOptions = {}): string {
  const L: string[] = [];
  L.push('# Prisma to Turbine migration report');
  L.push('');
  if (options.schemaPath) L.push(`Source: \`${options.schemaPath}\``);
  if (!options.noTimestamp) L.push(`Generated: ${new Date().toISOString()}`);
  L.push(`Mode: ${result.noDb ? 'parse-only (--no-db, no database resolution)' : 'resolved against live database'}`);
  L.push('');

  // ---- Summary ----------------------------------------------------------
  const modelCount = result.models.length;
  const resolvedModels = result.models.filter((m) => m.status === 'resolved').length;
  const unresolvedModels = result.models.filter((m) => m.status === 'unresolved').length;
  L.push('## Summary');
  L.push('');
  if (result.noDb) {
    L.push(`- Parsed ${modelCount} model(s), ${result.enums.length} enum(s).`);
    L.push('- No database URL provided - names were not resolved. Re-run without `--no-db` to resolve.');
  } else {
    L.push(
      `- Models: ${resolvedModels}/${modelCount} resolved${unresolvedModels ? `, ${unresolvedModels} UNRESOLVED` : ''}.`,
    );
    L.push(`- Enums: ${result.enums.filter((e) => e.status === 'resolved').length}/${result.enums.length} resolved.`);
    L.push(
      `- Overall: ${result.hasUnresolved ? 'INCOMPLETE (some items unresolved)' : 'complete (all items resolved)'}.`,
    );
  }
  L.push('');

  // ---- Model resolution table ------------------------------------------
  L.push('## Models');
  L.push('');
  L.push('| Prisma model | Turbine accessor | Table | Status |');
  L.push('| --- | --- | --- | --- |');
  for (const m of result.models) {
    L.push(`| ${m.prismaName} | ${m.accessor ?? '-'} | ${m.table ?? '-'} | ${modelDisplayStatus(m)} |`);
  }
  L.push('');

  // ---- Per-model detail -------------------------------------------------
  for (const m of result.models) {
    L.push(`### ${m.prismaName}`);
    L.push('');
    if (m.status === 'unresolved') {
      L.push(`> UNRESOLVED: ${m.reason ?? 'no matching table'}`);
      L.push('');
    }
    if (m.fields.length > 0) {
      L.push('Fields:');
      L.push('');
      for (const f of m.fields) {
        if (f.status === 'resolved') {
          L.push(`- \`${f.prismaName}\` -> \`${f.turbineField}\` (column \`${f.column}\`)`);
        } else if (f.status === 'parsed') {
          L.push(`- \`${f.prismaName}\` (parsed)`);
        } else {
          L.push(`- \`${f.prismaName}\` UNRESOLVED: ${f.reason}`);
        }
      }
      L.push('');
    }
    if (m.relations.length > 0) {
      L.push('Relations:');
      L.push('');
      for (const r of m.relations) {
        if (r.status === 'resolved') {
          const j = r.junction ? `, junction \`${r.junction}\`` : '';
          L.push(`- \`${r.prismaName}\` -> \`${r.turbineName}\` (${r.cardinality}${j})`);
        } else if (r.status === 'parsed') {
          L.push(`- \`${r.prismaName}\` -> ${r.targetModel} (parsed)`);
        } else {
          L.push(`- \`${r.prismaName}\` -> ${r.targetModel} UNRESOLVED: ${r.reason}`);
        }
      }
      L.push('');
    }
    if (m.compoundUniques.length > 0) {
      L.push('Compound unique / id selectors:');
      L.push('');
      for (const c of m.compoundUniques) {
        if (c.status === 'resolved') {
          L.push(`- \`${c.selector}\` (@@${c.kind}) -> [${c.turbineFields!.join(', ')}]`);
        } else if (c.status === 'parsed') {
          L.push(`- \`${c.selector}\` (@@${c.kind}, parsed): [${c.prismaFields.join(', ')}]`);
        } else {
          L.push(`- \`${c.selector}\` (@@${c.kind}) UNRESOLVED: ${c.reason}`);
        }
      }
      L.push('');
    }
  }

  // ---- Many-to-many call sites -----------------------------------------
  L.push(...manyToManySection(result));

  // ---- Junction tables --------------------------------------------------
  const junctions = new Set<string>();
  for (const m of result.models) {
    for (const r of m.relations) if (r.junction) junctions.add(r.junction);
  }
  if (junctions.size > 0) {
    L.push('## Junction tables (implicit m2m)');
    L.push('');
    for (const j of [...junctions].sort()) L.push(`- \`${j}\``);
    L.push('');
  }

  // ---- Enums ------------------------------------------------------------
  if (result.enums.length > 0) {
    L.push('## Enums');
    L.push('');
    for (const e of result.enums) {
      if (e.status === 'resolved') L.push(`- \`${e.prismaName}\` -> \`${e.turbineName}\``);
      else if (e.status === 'parsed') L.push(`- \`${e.prismaName}\` (parsed)`);
      else L.push(`- \`${e.prismaName}\` UNRESOLVED: ${e.reason}`);
    }
    L.push('');
  }

  // ---- Unresolved roll-up ----------------------------------------------
  const unresolved = collectUnresolved(result);
  if (unresolved.length > 0) {
    L.push('## Unresolved items');
    L.push('');
    for (const u of unresolved) L.push(`- ${u}`);
    L.push('');
  }

  // ---- Parser warnings --------------------------------------------------
  if (result.parseWarnings.length > 0) {
    L.push('## Parser notes');
    L.push('');
    for (const w of result.parseWarnings) L.push(`- ${w}`);
    L.push('');
  }

  // ---- Fixed semantic-divergence section --------------------------------
  L.push(SEMANTIC_DIVERGENCE);

  return `${L.join('\n')}\n`;
}

/** One resolved many-to-many relation, named from both sides. */
interface ManyToManyCallSite {
  /** `Model.field` as written in schema.prisma (what application code says). */
  prismaPath: string;
  /** The Prisma field name on its own (what to grep for). */
  prismaField: string;
  /** The Turbine relation name (what `generated/metadata.ts` says). */
  turbineName: string;
  /** Junction table, when it could be named. */
  junction?: string;
}

/** Every resolved manyToMany relation in the result, in model/field order. */
export function manyToManyCallSites(result: ResolutionResult): ManyToManyCallSite[] {
  const out: ManyToManyCallSite[] = [];
  for (const m of result.models) {
    for (const r of m.relations) {
      if (r.status !== 'resolved' || !r.turbineName) continue;
      if (!r.manyToMany && !r.junction) continue;
      out.push({
        prismaPath: `${m.prismaName}.${r.prismaName}`,
        prismaField: r.prismaName,
        turbineName: r.turbineName,
        junction: r.junction,
      });
    }
  }
  return out;
}

/**
 * The many-to-many audit section.
 *
 * A migration audit that greps the TURBINE relation names cannot find anything:
 * application code written against the compat client uses the PRISMA field
 * names, and the two are related only through `PRISMA_MAP`. That is true of
 * every compat integration, so the report resolves the pairing itself rather
 * than leaving it to a recipe the reader has to get right.
 */
function manyToManySection(result: ResolutionResult): string[] {
  const sites = manyToManyCallSites(result);
  if (sites.length === 0) {
    if (!result.noDb) return [];
    return [
      '## Many-to-many relations (audit these call sites)',
      '',
      'Not determined: many-to-many relations are recognized from the live database.',
      'Re-run without `--no-db` to get the audit list.',
      '',
    ];
  }

  const L: string[] = [];
  L.push('## Many-to-many relations (audit these call sites)');
  L.push('');
  L.push('Turbine and Prisma name these relations differently, and your application code');
  L.push('uses the PRISMA name. Grepping the Turbine relation name (for example');
  L.push('`grep -rn "manyToMany" generated/`, then searching for the names it prints) finds');
  L.push('nothing and silently reports a clean audit. Both names are paired below.');
  L.push('');
  L.push('| Prisma call site | Turbine relation | Junction table |');
  L.push('| --- | --- | --- |');
  for (const s of sites) {
    L.push(`| \`${s.prismaPath}\` | \`${s.turbineName}\` | ${s.junction ? `\`${s.junction}\`` : '-'} |`);
  }
  L.push('');
  L.push('Audit every write whose `data` nests one of the Prisma field names above');
  L.push('(`connect`, `disconnect`, `set`, `connectOrCreate`, `create`, `update`, `upsert`,');
  L.push('`delete`): those are the many-to-many writes in your codebase.');
  L.push('');
  L.push('```bash');
  L.push(`grep -rEn "\\b(${[...new Set(sites.map((s) => s.prismaField))].sort().join('|')})\\b" src`);
  L.push('```');
  L.push('');
  return L;
}

/** Flat list of unresolved item descriptions across the whole result. */
export function collectUnresolved(result: ResolutionResult): string[] {
  const out: string[] = [];
  for (const m of result.models) {
    if (m.status === 'unresolved') out.push(`Model ${m.prismaName}: ${m.reason ?? 'no matching table'}`);
    for (const f of m.fields) {
      if (f.status === 'unresolved') out.push(`${m.prismaName}.${f.prismaName} (field): ${f.reason}`);
    }
    for (const r of m.relations) {
      if (r.status === 'unresolved') out.push(`${m.prismaName}.${r.prismaName} (relation): ${r.reason}`);
    }
    for (const c of m.compoundUniques) {
      if (c.status === 'unresolved') out.push(`${m.prismaName}.${c.selector} (@@${c.kind}): ${c.reason}`);
    }
  }
  for (const e of result.enums) {
    if (e.status === 'unresolved') out.push(`Enum ${e.prismaName}: ${e.reason}`);
  }
  return out;
}

/** Static section documenting known Prisma-vs-Turbine behavior differences. */
const SEMANTIC_DIVERGENCE = `## Behavior notes (Prisma vs Turbine)

These are deliberate semantic differences to keep in mind when porting queries.
Phase 1 ships no runtime; it produces this report plus a typed name map. The
phase-2 \`turbine-orm/prisma-compat\` adapter handles most of these translations.

- Cursor pagination. Turbine cursors are EXCLUSIVE and the comparison direction
  follows the \`orderBy\` entry for the cursor field. Prisma cursors are
  INCLUSIVE and idiomatically paired with \`skip: 1\`. Port \`{ cursor, skip: n }\`
  (n >= 1) to a Turbine cursor plus \`offset: n - 1\`.
- Aggregate / groupBy \`_count\`. Prisma returns \`_count\` as a record
  (\`{ _all: n }\` / per-field counts). Turbine's scalar \`_count: true\` returns a
  number. Reshape as needed (the phase-2 adapter does this both directions).
- Paginated reads. Prisma appends an implicit \`ORDER BY <primary key> ASC\` to a
  \`findMany\` with \`take\`/\`skip\`; core Turbine emits a bare \`LIMIT\`, which is not
  deterministic (a row can appear on two pages or on none). The phase-2
  \`prisma-compat\` adapter restores Prisma's ordering; on the core client, pass an
  explicit \`orderBy\` or set \`implicitPkOrdering: true\`.
- Relation-array order. Without an \`orderBy\` on a \`with\`/\`include\` clause, the
  order of a to-many relation array is unspecified in Turbine (\`json_agg\` order).
  Add an explicit \`orderBy\` where order matters.
- Connection URL. Prefer an explicit \`sslmode\` in the connection URL (or the
  future-proof \`uselibpqcompat\` form) to avoid a per-boot pg SSL security
  warning.`;

/** A one-line-per-model console summary for the CLI. */
export function summaryLines(result: ResolutionResult): string[] {
  return result.models.map((m) => {
    const status = modelDisplayStatus(m);
    const target = m.accessor ? `${m.accessor} (${m.table})` : '-';
    return `${m.prismaName} -> ${target}  [${status}]`;
  });
}
