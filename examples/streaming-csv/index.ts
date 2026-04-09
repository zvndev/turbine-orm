/**
 * Streaming CSV export — 100K orders with nested line items at constant memory.
 *
 * The whole trick:
 *
 *   for await (const order of db.orders.findManyStream({
 *     with: { lineItems: true, customer: true },
 *     batchSize: 1000,
 *   })) { ... }
 *
 * A PostgreSQL cursor streams rows in batches of 1,000. Nested relations
 * come along for the ride. The process heap stays flat the whole time —
 * we print the live high-water mark so you can watch it not move.
 *
 * Run with `npm start > orders.csv` and watch the stderr progress meter.
 */

import { createWriteStream } from 'node:fs';
import { TurbineClient } from 'turbine-orm';
import { SCHEMA } from './generated/turbine/metadata.js';

async function main() {
  const db = new TurbineClient(
    { connectionString: process.env.DATABASE_URL, max: 4 },
    SCHEMA,
  );

  const outPath = process.env.OUT ?? 'orders.csv';
  const out = createWriteStream(outPath);

  // CSV header
  out.write('order_id,customer_email,status,total_cents,line_item_count,first_product\n');

  let count = 0;
  let peakHeapMb = 0;
  const started = Date.now();

  const printProgress = () => {
    const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    if (heapMb > peakHeapMb) peakHeapMb = heapMb;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const rate = Math.round(count / Number(elapsed || 1));
    process.stderr.write(
      `\r\x1b[K  ${count.toLocaleString()} rows · ${rate.toLocaleString()}/s · ` +
        `heap ${heapMb}MB (peak ${peakHeapMb}MB) · ${elapsed}s`,
    );
  };

  // Every level of the `with` is typed. `order.customer.email` autocompletes.
  for await (const order of db.orders.findManyStream({
    where: { status: 'shipped' },
    orderBy: { id: 'asc' },
    batchSize: 1000,
    with: {
      customer: true,
      lineItems: true,
    },
  })) {
    const first = order.lineItems[0]?.productName ?? '';
    out.write(
      `${order.id},${csvEscape(order.customer.email)},${order.status},` +
        `${order.totalCents},${order.lineItems.length},${csvEscape(first)}\n`,
    );
    count++;
    if (count % 1000 === 0) printProgress();
  }

  printProgress();
  out.end();
  process.stderr.write('\n\n');

  const seconds = (Date.now() - started) / 1000;
  console.error(`Wrote ${count.toLocaleString()} rows to ${outPath} in ${seconds.toFixed(1)}s`);
  console.error(`Peak heap: ${peakHeapMb} MB`);
  console.error();
  console.error('Compare this against a naive findMany — that would load');
  console.error('every order into memory before writing the first CSV row.');

  await db.disconnect();
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

main().catch((err) => {
  console.error('\nFailed:', err);
  process.exit(1);
});
