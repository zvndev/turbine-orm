/** Conservative SQLite lexical admission. This is not a SQL script splitter or a server parser. */
export function migrationStatement(sql: unknown): string {
  if (
    typeof sql !== 'string' ||
    sql.length === 0 ||
    sql.includes('\0') ||
    new TextEncoder().encode(sql).length > 100_000
  ) {
    throw new Error('Each D1 migration statement must be a nonempty string of at most 100000 UTF-8 bytes.');
  }
  const tokens: string[] = [];
  let ended = false;
  let start = 0;
  let end = 0;
  for (let i = 0; i < sql.length; ) {
    const c = sql[i]!;
    if (/[ \t\r\n\f\uFEFF]/.test(c)) {
      i++;
      continue;
    }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated SQLite migration comment.');
      i = end + 2;
      continue;
    }
    if (ended) throw new Error('Supply one SQLite statement per array entry; scripts and triggers are unsupported.');
    if (c === ';') {
      ended = true;
      i++;
      continue;
    }
    if (tokens.length === 0) start = i;
    // SQLite accepts single quotes as identifiers in some contexts and double
    // quotes as strings in others. Inspect decoded values of EVERY quote form.
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let value = '';
      let closed = false;
      i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          i++;
          if (c !== '[' && sql[i] === close) {
            value += close;
            i++;
          } else {
            closed = true;
            break;
          }
        } else value += sql[i++]!;
      }
      if (!closed) throw new Error('Unterminated SQLite migration quote.');
      if (/(?:_turbine_|sqlite_|d1_|_cf_)/i.test(value)) {
        throw new Error('Reserved D1 migration journal or engine identifier in quoted value.');
      }
      tokens.push('<quoted>');
      end = i;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i++;
      const token = sql.slice(start, i).toUpperCase();
      if (/(?:_TURBINE_|SQLITE_|D1_|_CF_)/.test(token)) throw new Error('Reserved D1 migration or engine identifier.');
      tokens.push(token);
      end = i;
      continue;
    }
    if (c.charCodeAt(0) > 126 || c.charCodeAt(0) < 32 || /[?:@$]/.test(c)) {
      throw new Error('Unsupported SQLite migration token or bind parameter; use literal, individually prepared SQL.');
    }
    tokens.push(c);
    i++;
    end = i;
  }
  const first = tokens[0];
  // Refuse capabilities rather than trying to filter every spelling of control
  // SQL. The native batch owns its transaction. No WITH, EXPLAIN, SELECT, PRAGMA,
  // ATTACH, VACUUM, REPLACE, TEMP, VIRTUAL, VIEW or TRIGGER entry is admitted.
  const allowed =
    (first === 'CREATE' &&
      (tokens[1] === 'TABLE' || tokens[1] === 'INDEX' || (tokens[1] === 'UNIQUE' && tokens[2] === 'INDEX'))) ||
    (first === 'ALTER' && tokens[1] === 'TABLE') ||
    (first === 'DROP' && (tokens[1] === 'TABLE' || tokens[1] === 'INDEX')) ||
    first === 'INSERT' ||
    first === 'UPDATE' ||
    first === 'DELETE';
  if (!allowed)
    throw new Error('Unsupported D1 migration SQL capability; use ordinary table/index DDL or INSERT/UPDATE/DELETE.');
  // workerd's native prepare rejects a comment-only tail after a semicolon.
  // Strip the leading/trailing trivia and delimiter, preserving the exact
  // original input separately for the journal checksum.
  return sql.slice(start, end);
}
