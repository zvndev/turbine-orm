/**
 * Load generator — fires N concurrent requests at /like/safe and /like/unsafe
 * in sequence, then reports how many clicks survived.
 *
 * Expected result: /like/safe lands exactly N. /like/unsafe loses 20-60%
 * depending on machine and pool size.
 *
 * Run with `npm run storm` after the server is up.
 */

const BASE = process.env.BASE ?? 'http://localhost:3000';
const CLICKS = Number(process.env.CLICKS ?? 10_000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 64);

async function hammer(route: string) {
  await fetch(`${BASE}/reset`, { method: 'POST' });

  let sent = 0;
  let failed = 0;
  const started = Date.now();

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (sent < CLICKS) {
      sent++;
      try {
        const r = await fetch(`${BASE}${route}`, { method: 'POST' });
        if (!r.ok) failed++;
      } catch {
        failed++;
      }
    }
  });

  await Promise.all(workers);

  const elapsed = ((Date.now() - started) / 1000).toFixed(2);
  const result = await fetch(`${BASE}/count`).then((r) => r.json() as Promise<{ likesCount: number }>);
  const actual = result.likesCount;
  const lost = CLICKS - actual;
  const lostPct = ((lost / CLICKS) * 100).toFixed(1);

  console.log(`${route}`);
  console.log(`  fired:    ${CLICKS.toLocaleString()} (concurrency ${CONCURRENCY})`);
  console.log(`  failures: ${failed}`);
  console.log(`  counter:  ${actual.toLocaleString()}`);
  console.log(`  lost:     ${lost.toLocaleString()} (${lostPct}%)`);
  console.log(`  time:     ${elapsed}s`);
  console.log();
}

async function main() {
  console.log(`Clickstorm → ${BASE}`);
  console.log();
  await hammer('/like/safe');
  await hammer('/like/unsafe');
  console.log('The atomic path is always exact. The naive path loses writes to the race.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
