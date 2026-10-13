/**
 * Shared live-Postgres fixture for the `transactions-*` integration suites.
 *
 * Each suite passes its own table prefix, so suites the test runner executes in
 * parallel never touch each other's tables. Every assertion about what was
 * stored reads through `raw`, a plain pg client, never through the ORM.
 */

import pg from 'pg';
import { TurbineClient, type TurbineConfig } from '../client.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';

export const DATABASE_URL = process.env.DATABASE_URL;

export interface TxFixture {
  readonly raw: pg.Client;
  readonly schema: SchemaMetadata;
  /** The suite's table names: `orgs`, `users`, `posts`, `counters`. */
  readonly t: { orgs: string; users: string; posts: string; counters: string };
  /** A client on the fixture schema, disconnected by {@link TxFixture.close}. */
  client(config?: Partial<TurbineConfig>): TurbineClient;
  /** Empty every table and reseed the base rows. */
  reset(): Promise<void>;
  /** Count rows of a fixture table matching an optional SQL predicate. */
  count(table: string, where?: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

/**
 * Tables, with `p` as the prefix:
 *   orgs(id, name UNIQUE)
 *   users(id, email UNIQUE, org_id NULL -> orgs, tenant)          relation `org` (belongsTo, nullable)
 *   posts(id, user_id NOT NULL -> users, title)                    relation `author` (belongsTo, required)
 *   counters(id PK, n, version)
 * Seed: orgs 1 'acme', 2 'globex'; users 1 a@x (org 1), 2 b@x (org 2), 3 c@x (no org);
 * posts 1 and 2 by user 1; counters (1, 100), (2, 0).
 */
export async function openFixture(prefix: string): Promise<TxFixture> {
  if (!DATABASE_URL) throw new Error('openFixture needs DATABASE_URL');
  const t = {
    orgs: `${prefix}_orgs`,
    users: `${prefix}_users`,
    posts: `${prefix}_posts`,
    counters: `${prefix}_counters`,
  };
  const raw = new pg.Client({ connectionString: DATABASE_URL });
  await raw.connect();
  // CockroachDB has no TRUNCATE ... RESTART IDENTITY, and its SERIAL draws
  // from unique_rowid(), so its reseed writes the ids explicitly.
  const cockroach = /cockroach/i.test((await raw.query('SELECT version() AS v')).rows[0].v as string);
  await raw.query(`
    DROP TABLE IF EXISTS ${t.posts}, ${t.users}, ${t.orgs}, ${t.counters} CASCADE;
    CREATE TABLE ${t.orgs} (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE ${t.users} (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      org_id INTEGER REFERENCES ${t.orgs}(id),
      tenant TEXT
    );
    CREATE TABLE ${t.posts} (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES ${t.users}(id),
      title TEXT NOT NULL
    );
    CREATE INDEX ON ${t.posts} (user_id);
    CREATE INDEX ON ${t.users} (org_id);
    CREATE TABLE ${t.counters} (id INTEGER PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0);
  `);
  const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const schema = await introspect({
    connectionString: DATABASE_URL,
    include: [t.orgs, t.users, t.posts, t.counters],
    relationNames: {
      [t.orgs]: { [camel(t.users)]: 'members' },
      [t.users]: { [camel(`${prefix}_org`)]: 'org', [camel(t.posts)]: 'posts' },
      [t.posts]: { [camel(`${prefix}_user`)]: 'author' },
    },
  });

  const clients: TurbineClient[] = [];
  const fixture: TxFixture = {
    raw,
    schema,
    t,
    client(config = {}) {
      const db = new TurbineClient(
        { connectionString: DATABASE_URL, warnOnUnlimited: false, ...config } as TurbineConfig,
        schema,
      );
      clients.push(db);
      return db;
    },
    async reset() {
      if (cockroach) {
        await raw.query(`
          DELETE FROM ${t.posts}; DELETE FROM ${t.users}; DELETE FROM ${t.orgs}; DELETE FROM ${t.counters};
          INSERT INTO ${t.orgs} (id, name) VALUES (1, 'acme'), (2, 'globex');
          INSERT INTO ${t.users} (id, email, org_id, tenant) VALUES (1, 'a@x', 1, 't1'), (2, 'b@x', 2, 't2'), (3, 'c@x', NULL, 't1');
          INSERT INTO ${t.posts} (id, user_id, title) VALUES (1, 1, 'p1'), (2, 1, 'p2');
          INSERT INTO ${t.counters} (id, n) VALUES (1, 100), (2, 0);
        `);
        return;
      }
      await raw.query(`
        TRUNCATE ${t.posts}, ${t.users}, ${t.orgs}, ${t.counters} RESTART IDENTITY CASCADE;
        INSERT INTO ${t.orgs} (name) VALUES ('acme'), ('globex');
        INSERT INTO ${t.users} (email, org_id, tenant) VALUES ('a@x', 1, 't1'), ('b@x', 2, 't2'), ('c@x', NULL, 't1');
        INSERT INTO ${t.posts} (user_id, title) VALUES (1, 'p1'), (1, 'p2');
        INSERT INTO ${t.counters} (id, n) VALUES (1, 100), (2, 0);
      `);
    },
    async count(table, where, params) {
      const r = await raw.query(`SELECT count(*)::int AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`, params);
      return r.rows[0].n as number;
    },
    async close() {
      for (const db of clients) await db.disconnect().catch(() => {});
      await raw.query(`DROP TABLE IF EXISTS ${t.posts}, ${t.users}, ${t.orgs}, ${t.counters} CASCADE`);
      await raw.end();
    },
  };
  return fixture;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
