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
