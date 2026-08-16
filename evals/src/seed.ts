/**
 * Deterministic seed for the held-out eval database.
 *
 * Every value is drawn from a fixed-seed PRNG, so `db:reset` reproduces the
 * exact same rows on any machine. A pass rate computed against shifting data is
 * not re-runnable, and the spec's gate is that a result must survive six
 * months.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { EVAL_DATABASE_URL, SEED } from './config.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** mulberry32: small, fast, fully deterministic from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

const CANTONS = ['VD', 'FR', 'JU', 'NE', 'VS', 'BE'] as const;
const GUILD_NAMES = [
  'Confrerie du Val Perdu',
  'Cave Saint-Ombre',
  'Fromagerie Haute-Combe',
  'Atelier Bise Noire',
  'Maison Pralong',
  'Cooperative Envers',
] as const;
const RIND_STYLES = ['washed', 'bloomy', 'natural', 'brushed', 'waxed'] as const;
const STATUSES = ['ripening', 'cellared', 'graded', 'dispatched', 'quarantined'] as const;
const GENERA = ['Penicillium', 'Brevibacterium', 'Geotrichum', 'Debaryomyces', 'Lactococcus'] as const;
const GIVEN = [
  'Anouk', 'Bertrand', 'Celine', 'Damien', 'Elodie', 'Fabien', 'Genevieve', 'Hugo',
  'Isaline', 'Jerome', 'Karin', 'Loic', 'Margaux', 'Nicolas', 'Odile', 'Pascal',
  'Quentin', 'Roselyne', 'Sylvain', 'Therese', 'Ulysse', 'Valerie', 'Wilfried', 'Xavier',
] as const;
const DESCRIPTORS = ['hazelnut', 'brothy', 'barnyard', 'grassy', 'ammoniated', 'buttery', 'onion', 'mushroom'] as const;

const dateStr = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const pool = new pg.Pool({ connectionString: EVAL_DATABASE_URL, max: 1 });
  const client = await pool.connect();

  try {
    if (reset) {
      const ddl = readFileSync(resolve(HERE, '..', 'schema.sql'), 'utf8');
      await client.query(ddl);
      console.log('schema applied');
    }

    await client.query('BEGIN');

    // -- guilds ------------------------------------------------------------
    const guildIds: number[] = [];
    for (let i = 0; i < GUILD_NAMES.length; i++) {
      const r = await client.query<{ id: number }>(
        'INSERT INTO guilds (guild_name, canton_code, founded_year) VALUES ($1,$2,$3) RETURNING id',
        [GUILD_NAMES[i], CANTONS[i % CANTONS.length], int(1874, 1996)],
      );
      guildIds.push(r.rows[0].id);
    }

    // -- affineurs ---------------------------------------------------------
    const affineurIds: number[] = [];
    for (let i = 0; i < 40; i++) {
      const guildId = pick(guildIds);
      const journeyman = rand() < 0.35;
      // ~30% carry no credential blob at all, so `is null` filters have bite.
      const blob =
        rand() < 0.3
          ? null
          : JSON.stringify({
              tier: pick(['master', 'journeyman', 'apprentice']),
              years: int(1, 34),
              certs: { hygiene: rand() < 0.8, cellar: rand() < 0.5 },
            });
      const retired = rand() < 0.2 ? `2024-${String(int(1, 12)).padStart(2, '0')}-15T09:00:00Z` : null;
      const r = await client.query<{ id: number }>(
        `INSERT INTO affineurs
           (ledger_handle, given_name, guild_id, tenure_started_on, is_journeyman, credential_blob, retired_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          `aff-${String(i + 1).padStart(3, '0')}`,
          `${pick(GIVEN)} ${pick(['Roux', 'Blanc', 'Chappuis', 'Morand', 'Dubois', 'Favre'])}`,
          guildId,
          dateStr(int(1998, 2023), int(1, 12), int(1, 28)),
          journeyman,
          blob,
          retired,
        ],
      );
      affineurIds.push(r.rows[0].id);
    }

    // -- cultures ----------------------------------------------------------
    const cultureIds: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await client.query<{ id: number }>(
        'INSERT INTO cultures (culture_code, genus, is_thermophilic) VALUES ($1,$2,$3) RETURNING id',
        [`CU-${String(i + 1).padStart(2, '0')}`, pick(GENERA), rand() < 0.4],
      );
      cultureIds.push(r.rows[0].id);
    }

    // -- cheese_wheels -----------------------------------------------------
    // batch_ref is unique only WITHIN a guild, which is what makes the
    // compound-unique findUnique task meaningful: the ref alone is ambiguous.
    const batchIds: number[] = [];
    const refCounter = new Map<number, number>();
    for (let i = 0; i < 300; i++) {
      const affineurId = pick(affineurIds);
      const g = await client.query<{ guild_id: number }>('SELECT guild_id FROM affineurs WHERE id = $1', [affineurId]);
      const guildId = g.rows[0].guild_id;
      const n = (refCounter.get(guildId) ?? 0) + 1;
      refCounter.set(guildId, n);
      const notes =
        rand() < 0.25
          ? null
          : JSON.stringify({
              panel: { score: int(1, 10), seats: int(2, 6) },
              descriptors: [pick(DESCRIPTORS), pick(DESCRIPTORS)],
            });
      const r = await client.query<{ id: number }>(
        `INSERT INTO cheese_wheels
           (batch_ref, affineur_id, guild_id, rind_style, cave_humidity_pct, wheel_count, pressed_on, status, tasting_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          `WB-${String(n).padStart(4, '0')}`,
          affineurId,
          guildId,
          pick(RIND_STYLES),
          int(78, 96),
          int(1, 60),
          dateStr(int(2022, 2025), int(1, 12), int(1, 28)),
          pick(STATUSES),
          notes,
        ],
      );
      batchIds.push(r.rows[0].id);
    }

    // -- ripening_checks ---------------------------------------------------
    for (const batchId of batchIds) {
      const checks = int(0, 8);
      for (let j = 0; j < checks; j++) {
        await client.query(
          `INSERT INTO ripening_checks
             (cheese_wheel_id, affineur_id, checked_on, rind_score, aroma_score, remark)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            batchId,
            pick(affineurIds),
            dateStr(int(2023, 2025), int(1, 12), int(1, 28)),
            int(1, 10),
            int(1, 10),
            rand() < 0.4 ? null : `${pick(DESCRIPTORS)} note, turn ${int(1, 12)}`,
          ],
        );
      }
    }

    // -- wheel_cultures (m2m) ----------------------------------------------
    for (const batchId of batchIds) {
      const used = new Set<number>();
      const n = int(0, 4);
      for (let j = 0; j < n; j++) {
        const cultureId = pick(cultureIds);
        if (used.has(cultureId)) continue;
        used.add(cultureId);
        await client.query('INSERT INTO wheel_cultures (cheese_wheel_id, culture_id) VALUES ($1,$2)', [
          batchId,
          cultureId,
        ]);
      }
    }

    await client.query('COMMIT');

    // ANALYZE so the MCP server's table_stats / doctor_report have real
    // planner estimates to report rather than zeros.
    await client.query('ANALYZE');

    const counts = await client.query<{ t: string; n: string }>(`
      SELECT 'guilds' t, count(*)::text n FROM guilds
      UNION ALL SELECT 'affineurs', count(*)::text FROM affineurs
      UNION ALL SELECT 'cultures', count(*)::text FROM cultures
      UNION ALL SELECT 'cheese_wheels', count(*)::text FROM cheese_wheels
      UNION ALL SELECT 'ripening_checks', count(*)::text FROM ripening_checks
      UNION ALL SELECT 'wheel_cultures', count(*)::text FROM wheel_cultures
      ORDER BY 1
    `);
    console.log(`seeded (SEED=${SEED}):`);
    for (const row of counts.rows) console.log(`  ${row.t.padEnd(16)} ${row.n}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
