/** Pure report constants and native-route admission; never loads ORM clients or generated code. */
import assert from 'node:assert/strict';

export const SECONDARY_SEMANTICS = 'pg-secondary-exact-ordered-v1';
export const STREAM_SCENARIO = 'stream, iterate 50K comments (batch 1000)';
export const LATENCY_SCENARIOS = [
  'findUnique by PK',
  'L2, 50 users + posts',
  'dashboard, 5 independent queries',
] as const;
export const DEEP_SCENARIO = 'list, published posts in org 1, newest first (deep offset)';
export const BATCH = 1000;
export type Role = 'turbine' | 'prisma' | 'stable' | 'rc' | 'raw';
export type RouteKind =
  | 'cursor'
  | 'keyset'
  | 'named'
  | 'unnamed'
  | 'read'
  | 'join'
  | 'batched'
  | 'pipeline'
  | 'transaction';

export interface Command {
  role: Role;
  pid: number;
  sql: string;
  name: string;
  values: unknown[];
  rows?: number;
  tags?: string[];
  error?: string;
}
export interface Wire {
  role: Role;
  pid: number;
  method: string;
  name: string;
  sql?: string;
}
export interface Trace {
  commands: Command[];
  wire: Wire[];
  completions: { role: Role; pid: number; tag: string }[];
}

export function assertRoute(trace: Trace, role: Role, kind: RouteKind): void {
  assert.ok(trace.commands.length || kind === 'pipeline', 'Missing executed commands');
  assert.ok(trace.wire.length, 'Missing wire messages');
  for (const command of trace.commands) {
    assert.equal(command.role, role, 'Arm used a different pool/driver route');
    assert.equal(command.error, undefined, 'Unexpected SQL failure');
    assert.ok(Number.isInteger(command.rows) && command.tags?.length, 'Missing command completion');
    if (command.name)
      assert.ok(
        trace.wire.some((w) => w.pid === command.pid && w.method === 'bind' && w.name === command.name),
        'Named query did not Bind its statement',
      );
  }
  assert.ok(
    trace.wire.every((w) => w.role === role),
    'Wire used a different pool/driver route',
  );
  const sql = trace.commands.map((c) => c.sql);
  if (kind === 'named' || kind === 'unnamed') {
    assert.equal(sql.length, 1, 'Single read expected');
    assert.equal(trace.commands[0]!.name.length > 0, kind === 'named', 'Prepared name route mismatch');
    assert.ok(
      trace.wire.some((w) => w.method === 'bind' && (kind === 'named' ? w.name.length > 0 : w.name === '')),
      'Extended protocol Bind route missing',
    );
  }
  if (kind === 'pipeline') {
    assert.equal(sql.length, 0, 'Native pipeline must use direct extended protocol, not sequential query fallback');
    const parses = trace.wire.filter((w) => w.method === 'parse');
    assert.equal(parses.length, 7, 'Pipeline must Parse BEGIN/five reads/COMMIT');
    assert.equal(parses[0]!.sql, 'BEGIN');
    assert.equal(parses.at(-1)!.sql, 'COMMIT');
    assert.ok(
      parses.slice(1, -1).every((w) => /^SELECT /i.test(w.sql!)),
      'Pipeline read missing',
    );
    assert.equal(trace.wire.filter((w) => w.method === 'sync').length, 1, 'Native pipeline must use one Sync');
    assert.equal(trace.wire.filter((w) => w.method === 'bind').length, 7, 'Pipeline Bind count mismatch');
    assert.equal(trace.wire.filter((w) => w.method === 'execute').length, 7, 'Pipeline Execute count mismatch');
    assert.deepEqual(
      trace.completions.map((c) => c.tag),
      ['BEGIN', 'SELECT 1', 'SELECT 1', 'SELECT 1', 'SELECT 5', 'SELECT 1', 'COMMIT'],
      'Pipeline completion set mismatch',
    );
  }
  if (kind === 'transaction') {
    assert.match(sql[0]!, /^BEGIN/i);
    assert.match(sql.at(-1)!, /^COMMIT/i);
    assert.equal(sql.filter((s) => /^select /i.test(s)).length, 5, 'Transaction must execute five reads');
  }
  if (kind === 'join') {
    assert.equal(sql.length, 1, 'Join relation arm made extra round trips');
    assert.match(sql[0]!, /json|lateral/i, 'Expected SQL relation aggregation');
  }
  if (kind === 'batched') {
    assert.equal(sql.length, 2, 'Batched relation arm must execute root and child reads');
    assert.ok(sql.every((s) => /^select /i.test(s)));
  }
  if (kind === 'keyset') {
    assert.equal(sql.length, 51, '50K/1000 keyset drain must include terminal empty page');
    for (const [i, c] of trace.commands.entries()) {
      assert.match(c.sql, /order by.*(?:id|"id").*asc/i, 'Keyset order missing');
      assert.match(c.sql, />/);
      assert.match(c.sql, /limit/i);
      assert.equal(c.rows, i === 50 ? 0 : BATCH, 'Keyset result was not a bounded page');
      assert.ok(
        c.values.some((v) => String(v) === String(i * BATCH)),
        'Keyset boundary did not advance',
      );
    }
    assert.ok(!sql.some((s) => /^(?:BEGIN|DECLARE|FETCH)/i.test(s)), 'Page emulation claimed a native stream');
  }
  if (kind === 'cursor') {
    const declare = sql.findIndex((s) => /^DECLARE /i.test(s));
    const begin = sql.findIndex((s) => /^BEGIN/i.test(s));
    assert.ok(begin >= 0 && declare === begin + 1, 'Missing native BEGIN/DECLARE route');
    assert.equal(begin, 1, 'Expected one bounded speculative SELECT before BEGIN');
    assert.equal(trace.commands[0]!.rows, BATCH + 1);
    assert.match(sql[0]!, /order by.*id.*asc/i);
    const cursor = /^DECLARE (\S+) NO SCROLL CURSOR FOR /i.exec(sql[declare]!)?.[1];
    assert.ok(cursor, 'Native cursor declaration missing');
    assert.match(sql[declare]!, /order by.*id.*asc/i);
    const fetches = trace.commands.slice(declare + 1, -2);
    assert.equal(fetches.length, 51, 'Native full drain must fetch until empty');
    for (const [i, c] of fetches.entries()) {
      assert.equal(c.sql, `FETCH ${BATCH} FROM ${cursor}`);
      assert.equal(c.rows, i === 50 ? 0 : BATCH, 'Native cursor read beyond the bounded page');
    }
    assert.equal(sql.at(-2), `CLOSE ${cursor}`);
    assert.equal(sql.at(-1), 'COMMIT');
  }
}

