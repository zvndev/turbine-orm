import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql as rcSql } from 'drizzle-rc';
import { drizzle as drizzleRc } from 'drizzle-rc/node-postgres';
import pg from 'pg';
import { TurbineClient } from '../generated/turbine/index.js';
import type { Row } from './equivalence.js';

export function assertSuppliedPrepared(client: TurbineClient, pool: pg.Pool): string {
  if (client.pool !== pool) throw new Error('Turbine must retain the actual supplied benchmark pg pool');
  const descriptor = client.users.buildFindUnique({ where: { id: 1 } });
  if (!descriptor.preparedName) throw new Error('Turbine fixed-arity descriptor needs a preparedName');
  return descriptor.preparedName;
}
export async function observeNativeQuery(pool: pg.Pool, call: () => Promise<unknown>) {
  const original = pool.query;
  const sent: { name?: string; text?: string }[] = [];
  pool.query = ((...args: unknown[]) => {
    const first = args[0];
    sent.push(typeof first === 'string' ? { text: first } : { ...(first as { name?: string; text?: string }) });
    return (original as (...args: unknown[]) => unknown).apply(pool, args);
  }) as typeof pool.query;
  try {
    return { value: await call(), sent };
  } finally {
    pool.query = original;
  }
}

import type { ExtendedArm } from './extended-equivalence.js';
import { commonArms } from './extended-equivalence.js';
import * as schema from './schema.js';
import * as rcSchema from './schema-rc.js';

export const userFields = ['id', 'org_id', 'email', 'name', 'role', 'avatar_url', 'last_login_at', 'created_at'];
export const postFields = [
  'id',
  'user_id',
  'org_id',
  'title',
  'content',
  'published',
  'view_count',
  'created_at',
  'updated_at',
];
export const tagFields = ['id', 'name', 'slug'];
export function jsonRow(alias: string, fields: readonly string[], encoding: string): string {
  const key = (f: string) => f.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return `json_build_${encoding === 'positional' ? 'array' : 'object'}(${fields.map((f) => (encoding === 'positional' ? `${alias}.${f}` : `'${key(f)}', ${alias}.${f}`)).join(', ')})`;
}
export function decodeJson(value: unknown, fields: readonly string[]): unknown {
  if (value === null) return null;
  if (Array.isArray(value) && value.length !== fields.length) throw new Error('Incorrect raw relation tuple width');
  if (!value || typeof value !== 'object') throw new Error('Invalid raw relation row');
  const row = Array.isArray(value)
    ? Object.fromEntries(fields.map((f, i) => [f.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value[i]]))
    : { ...(value as Row) };
  for (const field of ['lastLoginAt', 'createdAt', 'updatedAt'])
    if (Object.hasOwn(row, field) && row[field] !== null) row[field] = new Date(row[field] as string);
  return row;
}
type ColdClient = { query: () => Promise<unknown>; close: () => Promise<void> };
async function coldFactory(name: string, url: string, max: number, verifyNative: boolean): Promise<ColdClient> {
  const pool = new pg.Pool({ connectionString: url, max });
  let dispose: (() => Promise<void>) | undefined;
  try {
    if (name === 'Turbine') {
      const c = new TurbineClient({ pool, logging: false, preparedStatements: true });
      dispose = () => c.disconnect();
      await c.connect();
      await pool.query('SELECT 1');
      if (c.pool !== pool) throw new Error('Cold Turbine must retain the actual supplied pool');
      // Building a descriptor warms statement construction, so do it only in
      // the separate correctness preflight, never before a measured cold query.
      const preparedName = verifyNative ? assertSuppliedPrepared(c, pool) : undefined;
      return {
        query: async () => {
          if (!verifyNative) return c.users.findUnique({ where: { id: 1 } });
          const proof = await observeNativeQuery(pool, () => c.users.findUnique({ where: { id: 1 } }));
          if (proof.sent.length !== 1 || proof.sent[0]!.name !== preparedName)
            throw new Error('Cold Turbine must send the named descriptor through the supplied native pool');
          return proof.value;
        },
        close: async () => {
          try {
            await c.disconnect();
          } finally {
            await pool.end();
          }
        },
      };
    }
    if (name === 'Prisma 7') {
      const c = new PrismaClient({ adapter: new PrismaPg(pool) });
      dispose = () => c.$disconnect();
      await c.$queryRaw`SELECT 1`;
      return {
        query: () => c.user.findUnique({ where: { id: 1n } }),
        close: async () => {
          try {
            await c.$disconnect();
          } finally {
            await pool.end();
          }
        },
      };
    }
    if (name === 'Drizzle') {
      const c = drizzle(pool, { schema });
      await c.execute(sql`SELECT 1`);
      return { query: () => c.query.users.findFirst({ where: eq(schema.users.id, 1) }), close: () => pool.end() };
    }
    if (name === 'Drizzle RC') {
      const c = drizzleRc({ client: pool, relations: rcSchema.relations, jit: true });
      await c.execute(rcSql`SELECT 1`);
      return { query: () => c.query.users.findFirst({ where: { id: 1 } }), close: () => pool.end() };
    }
    await pool.query('SELECT 1');
    return { query: () => pool.query('SELECT * FROM users WHERE id=$1', [1]), close: () => pool.end() };
  } catch (e) {
    const errors = [e];
    try {
      if (dispose) await dispose();
    } catch (error) {
      errors.push(error);
    }
    try {
      await pool.end();
    } catch (error) {
      errors.push(error);
    }
    throw new AggregateError(errors, 'Cold setup/cleanup failed');
  }
}
export function coldArms(url: string, max: number): ExtendedArm[] {
  return commonArms.map((name) => {
    const run = async (timed: boolean) => {
      const client = await coldFactory(name, url, max, !timed);
      const errors: unknown[] = [];
      let result: { value: unknown; ms: number } | undefined;
      try {
        const start = timed ? performance.now() : 0;
        const value = await client.query();
        result = { value, ms: timed ? performance.now() - start : 0 };
      } catch (e) {
        errors.push(e);
      }
      try {
        await client.close();
      } catch (e) {
        errors.push(e);
      }
      if (errors.length) throw new AggregateError(errors, `Cold ${name} query/cleanup failed`);
      return result!;
    };
    return { name, fn: async () => (await run(false)).value, cold: () => run(true) };
  });
}
