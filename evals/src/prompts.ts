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
import { REPO_ROOT } from './config.js';
import { ddlText } from './schema-meta.js';
import type { Task } from './tasks.js';

export type Arm = 'A' | 'B' | 'C' | 'D' | 'E';

export const ARM_LABEL: Record<Arm, string> = {
  A: 'cold (schema DDL only)',
  B: 'docs (+ llms.txt)',
  C: 'tools (+ live turbine mcp)',
  D: 'skill (+ packaged skill)',
  E: 'skill only (schema DDL + packaged skill, no docs, no tools)',
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

/**
 * Arm D reads the PACKAGED skill, the file `npx turbine skill` installs, with
 * its frontmatter stripped (that is metadata for a skill loader, not content
 * for a model).
 *
 * It used to read a candidate copy under evals/, which meant the measured
 * artifact and the shipped one could drift apart silently, and after 0.72.0
 * they had: the candidate's table said a snake_case column name was REJECTED in
 * `orderBy`, which the release had just made false. Measuring the file that
 * ships is the only version of this that stays true.
 */
export function skillText(): string {
  const raw = readFileSync(resolve(REPO_ROOT, 'skills', 'turbine-orm', 'SKILL.md'), 'utf8');
  return raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

const TOOLS_NOTE = `You have MCP tools from a live \`turbine mcp\` server connected to the very database these tasks run against.
Use them. \`relation_graph\` and \`find_join_path\` report the exact relation names a \`with\` clause accepts,
\`table_detail\` and \`schema_overview\` report columns and types, and \`compile_query\` validates a set of query
args against the live schema before you commit to it. Reading a name is better than guessing one.`;

/**
 * The system prompt for an arm. Static across tasks, so it caches well.
 *
 * A-D are CUMULATIVE, which prices each layer against the one below it. **E is
 * not part of that ladder**: it is A plus the skill and nothing else, and it
 * exists because the cumulative design cannot answer the question the skill is
 * actually shipped for. In arm D the MCP tools are already connected, and a
 * model that can read the declared relation names does not need to be told how
 * they are derived, so D measures the skill where it has the least left to say.
 * Most people who install a skill do not also run an MCP server.
 */
export function systemFor(arm: Arm): string {
  const parts = [BASE_SYSTEM];
  if (arm === 'B' || arm === 'C' || arm === 'D') {
    parts.push(`# Turbine documentation\n\n${docsText()}`);
  }
  if (arm === 'C' || arm === 'D') {
    parts.push(`# Tools\n\n${TOOLS_NOTE}`);
  }
  if (arm === 'D' || arm === 'E') {
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
