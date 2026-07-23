/**
 * Hand-rolled `schema.prisma` subset parser (zero dependencies).
 *
 * Powers `turbine migrate-from-prisma`. It parses ONLY the constructs the
 * name-mapper needs (models, enums, views, fields, `@map`/`@@map`, relations
 * including implicit m2m junctions, `@@unique` including named selectors, and
 * `@@id`) and is deliberately LENIENT everywhere else: any attribute, block, or
 * token it does not recognize is skipped and recorded as a warning, never a
 * fatal error. The live DATABASE is the authority for resolution, so a partial
 * parse is still useful.
 *
 * It is a pure leaf like `cli/destructive.ts` - it reads a string and returns
 * data, touches no filesystem, database, or process state, and imports nothing
 * from the rest of the package.
 *
 * Where it MUST understand a construct (an unterminated block/string, a broken
 * `@@id`/`@@unique`/`@@map`/`@relation`) it throws {@link PrismaParseError} with
 * a 1-based line number.
 */

// ---------------------------------------------------------------------------
// Public AST
// ---------------------------------------------------------------------------

/** A parsed attribute argument: positional or `key: value`, string/array/raw. */
export interface PrismaAttrArg {
  /** Named-argument key (e.g. `fields`, `references`, `name`, `map`). Absent for positional args. */
  key?: string;
  /** `'string'` (unquoted literal), `'array'` (list of idents/strings), or `'raw'` (bare token). */
  kind: 'string' | 'array' | 'raw';
  /** Scalar value for string/raw kinds. */
  value?: string;
  /** Element list for the array kind (strings unquoted). */
  items?: string[];
}

/** A field- or block-level attribute (`@map(...)`, `@@unique(...)`, ...). */
export interface PrismaAttr {
  /** Attribute name without the leading `@`/`@@` (e.g. `map`, `relation`, `id`, `unique`). */
  name: string;
  /** Parsed argument list (empty when the attribute took no parens). */
  args: PrismaAttrArg[];
  /** True for a block attribute (`@@name`), false for a field attribute (`@name`). */
  block: boolean;
  /** 1-based source line the attribute was found on. */
  line: number;
}

/** A parsed field line inside a model/view/type block. */
export interface PrismaField {
  /** Field name as declared (the Prisma API name). */
  name: string;
  /** Base type with `[]` / `?` stripped (a scalar, enum, or model name). */
  type: string;
  /** Trailing `?` - the field is optional/nullable. */
  optional: boolean;
  /** Trailing `[]` - the field is a list. */
  isList: boolean;
  /** Field attributes in source order. */
  attrs: PrismaAttr[];
  /** 1-based source line. */
  line: number;
}

/** A compound key derived from a `@@id` / `@@unique` block attribute. */
export interface PrismaCompoundKey {
  /** Prisma field names participating, in declared order. */
  fields: string[];
  /** Explicit `name:` selector, else undefined (caller derives the underscore-join). */
  name?: string;
  /** Explicit `map:` constraint name, if any. */
  map?: string;
  /** `'id'` (from `@@id`) or `'unique'` (from `@@unique`). */
  kind: 'id' | 'unique';
  /** 1-based source line of the block attribute. */
  line: number;
}

/** A parsed `model` / `view` / `type` block. */
export interface PrismaModel {
  name: string;
  kind: 'model' | 'view' | 'type';
  /** `@@map("...")` target table name, if present. */
  map?: string;
  fields: PrismaField[];
  /** Compound keys from `@@id` and `@@unique`. */
  compoundKeys: PrismaCompoundKey[];
  /** Every block attribute (`@@index`, `@@schema`, ...), recorded verbatim. */
  blockAttrs: PrismaAttr[];
  /** 1-based source line of the block header. */
  line: number;
}

/** A parsed `enum` block. */
export interface PrismaEnum {
  name: string;
  /** Value names in declared order. */
  values: string[];
  /** `@@map("...")` target enum-type name, if present. */
  map?: string;
  line: number;
}

/** The full parse result. */
export interface PrismaSchemaAst {
  models: PrismaModel[];
  enums: PrismaEnum[];
  /** Non-fatal notes: skipped/unknown blocks and attributes. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Thrown for a malformed construct the parser must understand. Carries a line number. */
export class PrismaParseError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`schema.prisma line ${line}: ${message}`);
    this.name = 'PrismaParseError';
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// Comment stripping (string-aware, offset-preserving)
// ---------------------------------------------------------------------------

/**
 * Blank out `//` line comments (including `///` doc comments) with spaces,
 * preserving every newline and byte offset so line numbers stay exact. A `//`
 * inside a double-quoted string literal is left intact (e.g.
 * `@default("http://x")`). Prisma has no block-comment syntax.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      // Blank to end of line, keeping the newline.
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 1-based line number for a character offset. */
function lineAt(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Attribute-argument tokenizer
// ---------------------------------------------------------------------------

/** Unquote a `"..."` literal, resolving the escapes Prisma supports. */
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }
  return s;
}

/**
 * Split a balanced attribute-argument body on top-level commas, respecting
 * nested `(...)`, `[...]`, and `"..."`. Returns the raw comma-separated pieces.
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      cur += ch;
      if (ch === '\\' && i + 1 < body.length) {
        cur += body[i + 1];
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

/** Index of the first top-level `:` (outside strings/brackets), or -1. */
function topLevelColon(s: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

/** Parse one argument piece into a {@link PrismaAttrArg}. */
function parseArg(piece: string): PrismaAttrArg {
  const trimmed = piece.trim();
  // Named arg? `key: value` where the colon is at top level (not inside a
  // string). A bare `http://x` string literal is already inside quotes, so a
  // top-level colon before a quote/bracket is a named key.
  let key: string | undefined;
  let rest = trimmed;
  const colonIdx = topLevelColon(trimmed);
  if (colonIdx !== -1) {
    const maybeKey = trimmed.slice(0, colonIdx).trim();
    if (/^[a-zA-Z_]\w*$/.test(maybeKey)) {
      key = maybeKey;
      rest = trimmed.slice(colonIdx + 1).trim();
    }
  }

  if (rest.startsWith('[')) {
    const inner = rest.slice(1, rest.lastIndexOf(']'));
    const items = splitTopLevel(inner)
      .map((el) => unquote(el.trim()))
      .filter((el) => el !== '');
    return { key, kind: 'array', items };
  }
  if (rest.startsWith('"')) {
    return { key, kind: 'string', value: unquote(rest) };
  }
  return { key, kind: 'raw', value: rest };
}

/** Find the index of the `)` matching the `(` at `open`, respecting strings/nesting. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Scan a fragment (the tail of a field line, or a block-attribute line) for
 * attributes. Starts at each `@`, reads the attribute name, and, when followed
 * by `(`, captures the balanced parenthesized body.
 */
function parseAttributes(fragment: string, line: number): PrismaAttr[] {
  const attrs: PrismaAttr[] = [];
  let i = 0;
  while (i < fragment.length) {
    if (fragment[i] !== '@') {
      i++;
      continue;
    }
    const block = fragment[i + 1] === '@';
    let j = i + (block ? 2 : 1);
    const nameStart = j;
    while (j < fragment.length && /[\w.]/.test(fragment[j]!)) j++;
    const rawName = fragment.slice(nameStart, j);
    if (rawName === '') {
      i = j + 1;
      continue;
    }
    let args: PrismaAttrArg[] = [];
    // Skip spaces between the name and an optional '('.
    let k = j;
    while (k < fragment.length && (fragment[k] === ' ' || fragment[k] === '\t')) k++;
    if (fragment[k] === '(') {
      const close = matchParen(fragment, k);
      if (close === -1) {
        throw new PrismaParseError(`unterminated "(" in attribute @${block ? '@' : ''}${rawName}`, line);
      }
      const body = fragment.slice(k + 1, close);
      args = splitTopLevel(body).map(parseArg);
      j = close + 1;
    } else {
      j = k;
    }
    // `@db.VarChar(255)` etc. - keep only the head so `db` is the recorded name.
    attrs.push({ name: rawName.split('.')[0]!, args, block, line });
    i = j;
  }
  return attrs;
}

// ---------------------------------------------------------------------------
// Block scanning
// ---------------------------------------------------------------------------

interface RawBlock {
  keyword: string;
  name: string;
  body: string;
  headerLine: number;
  bodyOffset: number;
}

const BLOCK_KEYWORDS = new Set(['model', 'view', 'type', 'enum', 'datasource', 'generator']);

/** Find the `}` matching the `{` at `open`, respecting strings. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Scan the top level for `keyword Name { ... }` blocks via brace matching. */
function scanBlocks(src: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  const headerRe = /(^|\n)[ \t]*([a-zA-Z]+)[ \t]+([A-Za-z_]\w*)[ \t]*\{/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = headerRe.exec(src)) !== null) {
    const keyword = m[2]!;
    if (!BLOCK_KEYWORDS.has(keyword)) continue;
    const braceOpen = src.indexOf('{', m.index);
    const close = matchBrace(src, braceOpen);
    const headerLine = lineAt(src, m.index + m[1]!.length);
    if (close === -1) {
      throw new PrismaParseError(`unterminated "{" for ${keyword} ${m[3]}`, headerLine);
    }
    blocks.push({
      keyword,
      name: m[3]!,
      body: src.slice(braceOpen + 1, close),
      headerLine,
      bodyOffset: braceOpen + 1,
    });
    headerRe.lastIndex = close + 1;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

/**
 * Split a block body into logical lines, keeping each line's absolute source
 * offset so we can report exact line numbers. Prisma fields and block
 * attributes are single-line.
 */
function bodyLines(body: string, bodyOffset: number, src: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let offset = 0;
  for (const rawLine of body.split('\n')) {
    const text = rawLine.trim();
    if (text !== '') out.push({ text, line: lineAt(src, bodyOffset + offset) });
    offset += rawLine.length + 1; // + newline
  }
  return out;
}

/** Turn a `@@id` / `@@unique` attribute into a {@link PrismaCompoundKey}. */
function parseCompoundKey(attr: PrismaAttr, line: number): PrismaCompoundKey {
  const kind = attr.name === 'id' ? 'id' : 'unique';
  // Field list is the first array-kind arg (positional `[a, b]`) or a
  // `fields: [a, b]` named arg.
  const fieldsArg = attr.args.find((a) => a.kind === 'array' && (a.key === undefined || a.key === 'fields'));
  if (!fieldsArg?.items || fieldsArg.items.length === 0) {
    throw new PrismaParseError(`@@${attr.name} requires a field list, e.g. @@${attr.name}([a, b])`, line);
  }
  const nameArg = attr.args.find((a) => a.key === 'name');
  const mapArg = attr.args.find((a) => a.key === 'map');
  return {
    fields: fieldsArg.items,
    name: nameArg?.kind === 'string' ? nameArg.value : undefined,
    map: mapArg?.kind === 'string' ? mapArg.value : undefined,
    kind,
    line,
  };
}

function truncate(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

/** Parse a single field declaration line. Returns null for a non-field line. */
function parseFieldLine(text: string, line: number, warnings: string[]): PrismaField | null {
  // First token = field name, second token = type. Both are simple words; the
  // type may carry a trailing `[]` and/or `?`.
  const m = text.match(/^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\[\])?(\?)?/);
  if (!m) {
    // Not a field (e.g. a stray token); skip leniently.
    warnings.push(`Skipped unrecognized line ${line}: "${truncate(text)}"`);
    return null;
  }
  const name = m[1]!;
  const type = m[2]!;
  const isList = m[3] === '[]';
  const optional = m[4] === '?';
  const rest = text.slice(m[0].length);
  const attrs = parseAttributes(rest, line);
  return { name, type, optional, isList, attrs, line };
}

function parseModelBody(
  block: RawBlock,
  kind: 'model' | 'view' | 'type',
  src: string,
  warnings: string[],
): PrismaModel {
  const model: PrismaModel = {
    name: block.name,
    kind,
    fields: [],
    compoundKeys: [],
    blockAttrs: [],
    line: block.headerLine,
  };

  for (const { text, line } of bodyLines(block.body, block.bodyOffset, src)) {
    if (text.startsWith('@@')) {
      const attrs = parseAttributes(text, line);
      for (const attr of attrs) {
        model.blockAttrs.push(attr);
        if (attr.name === 'map') {
          const arg = attr.args.find((a) => a.key === undefined || a.key === 'name');
          if (arg?.kind !== 'string' || !arg.value) {
            throw new PrismaParseError(`@@map requires a quoted table name`, line);
          }
          model.map = arg.value;
        } else if (attr.name === 'id' || attr.name === 'unique') {
          model.compoundKeys.push(parseCompoundKey(attr, line));
        }
        // @@index, @@schema, and anything else: recorded in blockAttrs, unused.
      }
      continue;
    }

    // A field line: `name Type[modifiers] @attr @attr(...)`.
    const field = parseFieldLine(text, line, warnings);
    if (field) model.fields.push(field);
  }

  return model;
}

function parseEnumBody(block: RawBlock, src: string): PrismaEnum {
  const en: PrismaEnum = { name: block.name, values: [], line: block.headerLine };
  for (const { text, line } of bodyLines(block.body, block.bodyOffset, src)) {
    if (text.startsWith('@@')) {
      for (const attr of parseAttributes(text, line)) {
        if (attr.name === 'map') {
          const arg = attr.args.find((a) => a.key === undefined);
          if (arg?.kind === 'string' && arg.value) en.map = arg.value;
        }
      }
      continue;
    }
    const m = text.match(/^([A-Za-z_]\w*)/);
    if (m) en.values.push(m[1]!);
  }
  return en;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse a `schema.prisma` source string into a {@link PrismaSchemaAst}.
 *
 * Understands: model / view / type / enum blocks; field lines with `@map`,
 * `@id`, `@unique`, `@default`, `@updatedAt`, `@ignore`, `@relation`; and block
 * attributes `@@map`, `@@id`, `@@unique`, `@@index`, `@@schema`. Unknown
 * attributes and blocks are skipped into {@link PrismaSchemaAst.warnings}.
 *
 * @throws {@link PrismaParseError} on an unterminated block/paren/string or a
 *   structurally broken `@@id` / `@@unique` / `@@map`.
 */
export function parsePrismaSchema(source: string): PrismaSchemaAst {
  const src = stripComments(source);
  const ast: PrismaSchemaAst = { models: [], enums: [], warnings: [] };

  for (const block of scanBlocks(src)) {
    switch (block.keyword) {
      case 'model':
        ast.models.push(parseModelBody(block, 'model', src, ast.warnings));
        break;
      case 'view':
        ast.models.push(parseModelBody(block, 'view', src, ast.warnings));
        break;
      case 'type':
        // Composite/embedded types (MongoDB) are not tables. Parse leniently so
        // relation fields typed as such a model still resolve, but record a note.
        ast.models.push(parseModelBody(block, 'type', src, ast.warnings));
        ast.warnings.push(`Block "type ${block.name}" parsed but not resolved (composite types are not tables).`);
        break;
      case 'enum':
        ast.enums.push(parseEnumBody(block, src));
        break;
      case 'datasource':
      case 'generator':
        // Configuration blocks - irrelevant to name mapping.
        break;
      default:
        ast.warnings.push(`Skipped unsupported block "${block.keyword} ${block.name}".`);
        break;
    }
  }

  return ast;
}
