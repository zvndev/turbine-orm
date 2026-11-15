/** Original comparison volumes and values, translated to native MySQL DDL. */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generate } from 'turbine-orm';
import { introspectMysqlWith, MysqlPool } from 'turbine-orm/mysql';
import { installedIdentity } from './mysql-comparison-provenance.js';
import { bind, COUNTS, FIXTURE_TIME, makePool } from './mysql-comparison-config.js';

export async function seedMysql() {
  installedIdentity();
  assert.equal(
    process.env.MYSQL_COMPARISON_OWNED,
    '1',
    'destructive seed requires MYSQL_COMPARISON_OWNED=1 on your own database',
  );
  const pool = makePool();
  try {
    for (const name of [
      'post_tags',
      'comments',
      'posts',
      'users',
      'tags',
      'organizations',
      'bench_wide',
      'bench_writes',
    ])
      await pool.query(`DROP TABLE IF EXISTS \`${name}\``);
    const pk = 'id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY';
    const date = 'DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)';
    const ddl = [
      `CREATE TABLE organizations (${pk}, name TEXT NOT NULL, slug VARCHAR(191) NOT NULL UNIQUE, plan TEXT NOT NULL, created_at ${date})`,
      `CREATE TABLE users (${pk}, org_id BIGINT NOT NULL, email VARCHAR(191) NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL, avatar_url TEXT NULL, last_login_at DATETIME(3) NULL, created_at ${date}, FOREIGN KEY (org_id) REFERENCES organizations(id), INDEX idx_users_org_id(org_id))`,
      `CREATE TABLE posts (${pk}, user_id BIGINT NOT NULL, org_id BIGINT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, published BOOLEAN NOT NULL DEFAULT FALSE, view_count INT NOT NULL DEFAULT 0, created_at ${date}, updated_at ${date}, FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (org_id) REFERENCES organizations(id), INDEX idx_posts_user_id(user_id), INDEX idx_posts_org_id(org_id), INDEX idx_posts_created_at(created_at))`,
      `CREATE TABLE comments (${pk}, post_id BIGINT NOT NULL, user_id BIGINT NOT NULL, body TEXT NOT NULL, created_at ${date}, FOREIGN KEY (post_id) REFERENCES posts(id), FOREIGN KEY (user_id) REFERENCES users(id), INDEX idx_comments_post_id(post_id), INDEX idx_comments_user_id(user_id))`,
      `CREATE TABLE tags (${pk}, name VARCHAR(191) NOT NULL UNIQUE, slug VARCHAR(191) NOT NULL UNIQUE)`,
      'CREATE TABLE post_tags (post_id BIGINT NOT NULL, tag_id BIGINT NOT NULL, PRIMARY KEY(post_id, tag_id), FOREIGN KEY(post_id) REFERENCES posts(id), FOREIGN KEY(tag_id) REFERENCES tags(id), INDEX idx_post_tags_tag_id(tag_id))',
      `CREATE TABLE bench_wide (${pk}, ${[...Array.from({ length: 20 }, (_, i) => `t${String(i + 1).padStart(2, '0')} TEXT NOT NULL`), ...Array.from({ length: 10 }, (_, i) => `n${String(i + 1).padStart(2, '0')} INT NOT NULL`), ...Array.from({ length: 5 }, (_, i) => `b${String(i + 1).padStart(2, '0')} BOOLEAN NOT NULL`), ...Array.from({ length: 3 }, (_, i) => `d${String(i + 1).padStart(2, '0')} DATETIME(3) NOT NULL`)].join(', ')})`,
      `CREATE TABLE bench_writes (${pk}, org_id BIGINT NOT NULL, slug VARCHAR(191) NOT NULL UNIQUE, label TEXT NOT NULL, amount INT NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE, created_at ${date}, INDEX idx_bench_writes_org_id(org_id))`,
    ];
    for (const sql of ddl) await pool.query(sql);
    const insert = async (table: string, columns: string[], rows: unknown[][]) => {
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        await pool.execute(
          `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(',')}) VALUES ${batch.map(() => `(${columns.map(() => '?').join(',')})`).join(',')}`,
          bind(batch.flat()),
        );
      }
    };
    await insert(
      'organizations',
      ['name', 'slug', 'plan', 'created_at'],
      [
        ['Acme Inc', 'acme', 'enterprise', FIXTURE_TIME],
        ['Beta LLC', 'beta', 'pro', FIXTURE_TIME],
        ['Gamma Co', 'gamma', 'pro', FIXTURE_TIME],
        ['Delta Corp', 'delta', 'free', FIXTURE_TIME],
        ['Epsilon Studios', 'epsilon', 'free', FIXTURE_TIME],
      ],
    );
    await insert(
      'users',
      ['org_id', 'email', 'name', 'role', 'created_at'],
      Array.from({ length: 1000 }, (_, j) => {
        const i = j + 1;
        return [
          ((i - 1) % 5) + 1,
          `user${i}@bench.example.com`,
          `User ${i}`,
          i % 10 === 0 ? 'admin' : i % 5 === 0 ? 'editor' : 'member',
          FIXTURE_TIME,
        ];
      }),
    );
    await insert(
      'posts',
      ['user_id', 'org_id', 'title', 'content', 'published', 'view_count', 'created_at', 'updated_at'],
      Array.from({ length: 10000 }, (_, i) => {
        const u = Math.floor(i / 10) + 1,
          p = (i % 10) + 1;
        return [
          u,
          ((u - 1) % 5) + 1,
          `Post ${p} from user ${u}`,
          `Content body for post ${p} by user ${u}. Lorem ipsum dolor sit amet consectetur.`,
          p % 3 !== 0,
          (p * 17) % 500,
          FIXTURE_TIME,
          FIXTURE_TIME,
        ];
      }),
    );
    await insert(
      'comments',
      ['post_id', 'user_id', 'body', 'created_at'],
      Array.from({ length: 50000 }, (_, i) => {
        const p = Math.floor(i / 5) + 1,
          c = (i % 5) + 1;
        return [
          p,
          ((p + c - 1) % 1000) + 1,
          `Comment ${c} on post ${p}. Great article, thanks for sharing!`,
          FIXTURE_TIME,
        ];
      }),
    );
    await insert(
      'tags',
      ['name', 'slug'],
      Array.from({ length: 50 }, (_, i) => [`Tag ${i + 1}`, `tag-${i + 1}`]),
    );
    await insert(
      'post_tags',
      ['post_id', 'tag_id'],
      Array.from({ length: 10000 }, (_, i) =>
        [0, 17, 31].map((off) => [i + 1, ((((i + 1) % 50) + off) % 50) + 1]),
      ).flat(),
    );
    const wideCols = [
      ...Array.from({ length: 20 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`),
      ...Array.from({ length: 10 }, (_, i) => `n${String(i + 1).padStart(2, '0')}`),
      ...Array.from({ length: 5 }, (_, i) => `b${String(i + 1).padStart(2, '0')}`),
      ...Array.from({ length: 3 }, (_, i) => `d${String(i + 1).padStart(2, '0')}`),
    ];
    await insert(
      'bench_wide',
      wideCols,
      Array.from({ length: 2000 }, (_, j) => {
        const i = j + 1;
        return [
          ...Array.from({ length: 20 }, (_, k) => `row ${i} text value ${k + 1}`),
          ...Array.from({ length: 10 }, (_, k) => (i * (k + 3)) % 10000),
          ...Array.from({ length: 5 }, (_, k) => (i + k) % 2 === 0),
          ...Array.from({ length: 3 }, (_, k) => new Date(1700000000000 + i * (k + 1) * 1000)),
        ];
      }),
    );
    for (const [table, n] of Object.entries(COUNTS)) {
      const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
      assert.equal(Number((rows as { n: unknown }[])[0]!.n), n, `seed ${table}`);
      await pool.query(`ANALYZE TABLE \`${table}\``);
    }
    const [rows] = await pool.query('SELECT DATABASE() AS db');
    const metadata = await introspectMysqlWith(
      async (sql, params) => (await new MysqlPool(pool).query(sql, params)).rows as Record<string, unknown>[],
      (rows as { db: string }[])[0]!.db,
      { logger: {} },
    );
    generate({
      schema: metadata,
      target: 'mysql',
      exactNativeIntegers: true,
      noTimestamp: true,
      outDir: fileURLToPath(new URL('./generated/turbine-mysql', import.meta.url)),
      logger: {},
    });
    console.log(
      JSON.stringify({
        stage: 'mysql-seeded',
        counts: COUNTS,
        fixtureTime: FIXTURE_TIME,
        generated: 'benchmarks/generated/turbine-mysql',
      }),
    );
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  seedMysql().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
