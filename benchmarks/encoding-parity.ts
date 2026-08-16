/**
 * Prove that the two relation JSON encodings return the SAME rows.
 *
 * The 0.71.0 default flip (`json_build_object` to `json_build_array` on
 * PostgreSQL) is only publishable as a free win if the rows a caller receives
 * are unchanged. Positional decoding maps array POSITIONS back to field names
 * from a build-time shape, so the failure mode it introduces is not an
 * exception, it is a silently transposed field: `title` holding what `content`
 * should hold, with every type still plausible. A benchmark cannot see that.
 * Deep equality on real rows can.
 *
 * This is a spot check on the benchmark fixture, deliberately not a substitute
 * for `src/test/strategy-fuzz.test.ts`, which is where this property belongs.
 * It exists so the benchmark writeup's "byte-identical" claim is something this
 * round actually measured rather than something it inherited.
 *
 *   DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx encoding-parity.ts
 */

import { TurbineClient } from '../generated/turbine/index.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench_070?host=/tmp';

async function main() {
  const objectDb = new TurbineClient({ connectionString: DATABASE_URL, logging: false, jsonEncoding: 'object' });
  const arrayDb = new TurbineClient({ connectionString: DATABASE_URL, logging: false, jsonEncoding: 'positional' });

  const shapes: [string, (db: TurbineClient) => Promise<unknown>][] = [
    ['L2, 50 users + posts', (db) => db.users.findMany({ limit: 50, with: { posts: true } })],
    [
      'L3, 10 users -> posts -> comments',
      (db) => db.users.findMany({ limit: 10, with: { posts: { with: { comments: true }, limit: 5 } } }),
    ],
    [
      'findUnique L3',
      (db) => db.users.findUnique({ where: { id: 1 }, with: { posts: { with: { comments: true } } } }),
    ],
    [
      'relation with select + orderBy',
      (db) =>
        db.users.findMany({
          limit: 20,
          with: { posts: { select: { id: true, title: true }, orderBy: { createdAt: 'desc' }, limit: 3 } },
        }),
    ],
    [
      'relation with a where',
      (db) => db.users.findMany({ limit: 20, with: { posts: { where: { published: true } } } }),
    ],
  ];

  let failed = 0;
  for (const [name, run] of shapes) {
    const [o, a] = await Promise.all([run(objectDb), run(arrayDb)]);
    // JSON.stringify is order-sensitive on keys, which is what we want: a
    // positional decode that rebuilt the object with a different key order
    // would be a real difference in what the caller sees from Object.keys.
    const oj = JSON.stringify(o);
    const aj = JSON.stringify(a);
    const ok = oj === aj;
    if (!ok) failed++;
    const children = Array.isArray(o) ? JSON.stringify(o).length : oj.length;
    console.log(`  ${ok ? 'IDENTICAL' : 'DIFFERENT '}  ${name.padEnd(36)} (${children} bytes serialized)`);
    if (!ok) {
      console.log(`    object: ${oj.slice(0, 240)}`);
      console.log(`    array : ${aj.slice(0, 240)}`);
    }
  }

  await objectDb.disconnect();
  await arrayDb.disconnect();

  if (failed > 0) {
    console.error(`\n${failed} shape(s) DIFFER between encodings.`);
    process.exit(1);
  }
  console.log('\nAll shapes identical between object and positional encodings.');
}

main().catch((err) => {
  console.error('\nError:', err);
  process.exit(1);
});
