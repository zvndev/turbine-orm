/**
 * The answer protocol.
 *
 * A model answers with a fenced ```json block holding
 *   { "table": "...", "method": "...", "args": { ... } }
 *
 * Structured args rather than TypeScript source, for three reasons that all
 * bear on whether the number is trustworthy:
 *
 *   1. No eval. Running model-authored code would mean `new Function` on a
 *      string an LLM wrote, which this repo forbids outright and which would
 *      make the harness itself the least trustworthy thing in the artifact.
 *   2. Scoring stays about the query, not about syntax. A missing semicolon is
 *      not evidence that the MCP tools do or do not help.
 *   3. It is the shape the ORM's own surface already takes, and the shape
 *      `compile_query` validates, so nothing is being translated on the way in.
 *
 * READS ONLY. The method whitelist is the write guard: every accepted method
 * routes to a SELECT builder, so no model answer can reach a write path however
 * the args are shaped. Values are parameterised by Turbine as usual.
 */

export const READ_METHODS = [
  'findMany',
  'findFirst',
  'findUnique',
  'findFirstOrThrow',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
] as const;

export type ReadMethod = (typeof READ_METHODS)[number];

export interface Answer {
  table: string;
  method: ReadMethod;
  args: Record<string, unknown>;
}

export type ParseResult =
  | { ok: true; answer: Answer; raw: string }
  | { ok: false; reason: string; raw: string };

/**
 * Pull the last fenced JSON object out of a completion.
 *
 * The LAST block, deliberately: a model that reasons in prose often shows a
 * wrong first attempt then corrects it, and the final block is the answer it is
 * standing behind. Taking the first would score a draft.
 */
export function parseAnswer(text: string): ParseResult {
  const raw = text ?? '';
  const candidates: string[] = [];

  const fenceRe = /```(?:json|jsonc|JSON)?\s*\n([\s\S]*?)```/g;
  for (let m = fenceRe.exec(raw); m !== null; m = fenceRe.exec(raw)) {
    if (m[1]) candidates.push(m[1]);
  }

  // Unfenced fallback: the outermost brace-balanced span. Small models very
  // often skip the fence entirely, and failing them for formatting would
  // inflate the gap between model tiers with something that is not about
  // queries at all.
  if (candidates.length === 0) {
    const span = outermostJsonSpan(raw);
    if (span) candidates.push(span);
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = tryParse(candidates[i] as string);
    if (parsed) {
      const check = validateAnswer(parsed);
      if (check.ok) return { ok: true, answer: check.answer, raw };
      // Keep looking: an earlier block may be the real answer if the last one
      // is a fragment (a `where` snippet quoted while explaining, say).
    }
  }

  // Report the most specific reason we can, so failure classes stay honest.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = tryParse(candidates[i] as string);
    if (parsed) {
      const check = validateAnswer(parsed);
      if (!check.ok) return { ok: false, reason: check.reason, raw };
    }
  }
  return { ok: false, reason: candidates.length ? 'no valid JSON object in output' : 'no JSON block in output', raw };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    const span = outermostJsonSpan(text);
    if (!span) return undefined;
    try {
      return JSON.parse(span);
    } catch {
      return undefined;
    }
  }
}

/** Brace-balanced scan that ignores braces inside strings. */
function outermostJsonSpan(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

type ValidateResult = { ok: true; answer: Answer } | { ok: false; reason: string };

function validateAnswer(value: unknown): ValidateResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'answer is not a JSON object' };
  }
  const obj = value as Record<string, unknown>;
  const table = obj.table;
  const method = obj.method;
  if (typeof table !== 'string' || table.length === 0) return { ok: false, reason: 'missing "table"' };
  if (typeof method !== 'string') return { ok: false, reason: 'missing "method"' };
  if (!(READ_METHODS as readonly string[]).includes(method)) {
    return { ok: false, reason: `method "${method}" is not one of ${READ_METHODS.join(', ')}` };
  }
  const args = obj.args === undefined ? {} : obj.args;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, reason: '"args" is not a JSON object' };
  }
  return { ok: true, answer: { table, method: method as ReadMethod, args: args as Record<string, unknown> } };
}
