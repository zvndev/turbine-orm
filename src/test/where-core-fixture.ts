/**
 * Shared build-only fixture for the where-core suites: a table with one column
 * of every operand kind (scalar, json, array) plus to-many, to-one and
 * compound-key neighbours, and a way to drive the where compiler directly,
 * below the args seam that prunes `undefined`.
 */

import type { QueryInterfaceOptions } from '../query/deferred.js';
import type { BuilderCtx } from '../query/where.js';
import * as whereMod from '../query/where.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

export function whereCoreSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      accounts: mockTable(
        'accounts',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'email', field: 'email', pgType: 'text', unique: true },
          { name: 'age', field: 'age', pgType: 'int4' },
          { name: 'score', field: 'score', pgType: 'int4' },
          { name: 'meta', field: 'meta', pgType: 'jsonb' },
          { name: 'tags', field: 'tags', pgType: '_text' },
          { name: 'tenant_id', field: 'tenantId', pgType: 'int4' },
        ],
        {
          posts: {
            type: 'hasMany',
            name: 'posts',
            from: 'accounts',
            to: 'posts',
            foreignKey: 'account_id',
            referenceKey: 'id',
          },
          profile: {
            type: 'hasOne',
            name: 'profile',
            from: 'accounts',
            to: 'profiles',
            foreignKey: 'account_id',
            referenceKey: 'id',
          },
        },
      ),
      posts: mockTable(
        'posts',
        [
          { name: 'id', field: 'id' },
          { name: 'account_id', field: 'accountId' },
          { name: 'title', field: 'title', pgType: 'text' },
          { name: 'views', field: 'views', pgType: 'int4' },
          { name: 'tenant_id', field: 'tenantId', pgType: 'int4' },
        ],
        {
          author: {
            type: 'belongsTo',
            name: 'author',
            from: 'posts',
            to: 'accounts',
            foreignKey: 'account_id',
            referenceKey: 'id',
          },
        },
      ),
      profiles: mockTable('profiles', [
        { name: 'id', field: 'id' },
        { name: 'account_id', field: 'accountId' },
        { name: 'bio', field: 'bio', pgType: 'text' },
      ]),
      memberships: mockTable(
        'memberships',
        [
          { name: 'org_id', field: 'orgId' },
          { name: 'user_id', field: 'userId' },
          { name: 'role', field: 'role', pgType: 'text' },
        ],
        {},
        ['org_id', 'user_id'],
      ),
    },
  };
}

export function accounts(options?: QueryInterfaceOptions) {
  return makeQuery('accounts', whereCoreSchema(), options);
}

/** The private builder context, so a test can call the where compiler with no args seam in front of it. */
export function ctxOf(q: object): BuilderCtx {
  return (q as unknown as { ctx: BuilderCtx }).ctx;
}

export interface CompiledWhere {
  sql: string | null;
  buildParams: unknown[];
  collectParams: unknown[];
  fingerprint: string;
}

/** Compile `where` three ways (SQL build, cache-hit param collect, cache-key fingerprint). */
export function compileWhere(where: Record<string, unknown>, q: object = accounts()): CompiledWhere {
  const ctx = ctxOf(q);
  const buildParams: unknown[] = [];
  const sql = whereMod.buildWhereClause(ctx, where, buildParams);
  const collectParams: unknown[] = [];
  whereMod.collectWhereParams(ctx, where, collectParams);
  return { sql, buildParams, collectParams, fingerprint: whereMod.fingerprintWhere(ctx, where) };
}

/** Highest `$N` placeholder in `sql` (0 when none). */
export function maxPlaceholder(sql: string | null): number {
  let max = 0;
  for (const m of (sql ?? '').matchAll(/\$(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}
