/**
 * Prompt assembly, one function per layer.
 *
 * The arms are CUMULATIVE: B is A plus docs, C is B plus tools, D is C plus the
 * candidate skill. That is what makes A->B, B->C and C->D readable as "what
 * this layer bought", which is the whole point of running four arms instead of
 * two.
 *
 * The base system prompt is deliberately thin. It states the answer protocol
 * and lists the method names, because without those there is no way to answer
 * at all and arm A would be measuring whether a model can guess an API's method
 * names rather than whether it can read a schema. It teaches nothing else: not
 * `with` vs `include`, not operator spellings, not relation naming, not the
 * groupBy/having shape. Every one of those is left for the later arms to
 * supply, because those are precisely the things we are trying to price.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EVALS_DIR, REPO_ROOT } from './config.js';
import { ddlText } from './schema-meta.js';
import type { Task } from './tasks.js';

export type Arm = 'A' | 'B' | 'C' | 'D';

export const ARM_LABEL: Record<Arm, string> = {
  A: 'cold (schema DDL only)',
  B: 'docs (+ llms.txt)',
  C: 'tools (+ live turbine mcp)',
  D: 'skill (+ candidate skill)',
};

export const BASE_SYSTEM = `You are answering database query tasks using Turbine, a TypeScript ORM for PostgreSQL.

You will be given one task written in English. Work out the Turbine query that answers it exactly.

Reply with a single fenced JSON block and nothing after it:

\`\`\`json
{ "table": "<table name>", "method": "<method>", "args": { } }
\`\`\`

- "table" is the SQL table name exactly as it appears in the schema.
- "method" is one of: findMany, findFirst, findUnique, findFirstOrThrow, findUniqueOrThrow, count, aggregate, groupBy.
- "args" is the single arguments object that method accepts.

Return exactly one JSON block. Do not add extra wrapper keys. Do not return SQL.`;

export function docsText(): string {
  return readFileSync(resolve(REPO_ROOT, 'site', 'public', 'llms.txt'), 'utf8');
}

export function skillText(): string {
  return readFileSync(resolve(EVALS_DIR, 'candidate-skill.md'), 'utf8');
}

const TOOLS_NOTE = `You have MCP tools from a live \`turbine mcp\` server connected to the very database these tasks run against.
Use them. \`relation_graph\` and \`find_join_path\` report the exact relation names a \`with\` clause accepts,
\`table_detail\` and \`schema_overview\` report columns and types, and \`compile_query\` validates a set of query
args against the live schema before you commit to it. Reading a name is better than guessing one.`;

/** The system prompt for an arm. Static across tasks, so it caches well. */
export function systemFor(arm: Arm): string {
  const parts = [BASE_SYSTEM];
  if (arm === 'B' || arm === 'C' || arm === 'D') {
    parts.push(`# Turbine documentation\n\n${docsText()}`);
  }
  if (arm === 'C' || arm === 'D') {
    parts.push(`# Tools\n\n${TOOLS_NOTE}`);
  }
  if (arm === 'D') {
    parts.push(`# Query-writing guide\n\n${skillText()}`);
  }
  return parts.join('\n\n---\n\n');
}

/** The user turn: the schema, then the one task. */
export function userFor(task: Task): string {
  return `# Schema

The database has exactly these tables:

\`\`\`sql
${ddlText()}
\`\`\`

# Task

${task.prompt}`;
}
