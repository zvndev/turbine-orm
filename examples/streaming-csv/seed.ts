/**
 * Seed 100K orders × 1-5 line items each (≈300K rows). Uses UNNEST batch
 * inserts so the seed finishes in a few seconds instead of 10 minutes.
 *
 * Controlled by the ORDERS env var (default 100_000). Drop it to 10_000
 * for a quick dev loop.
 */
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const TARGET_ORDERS = Number(process.env.ORDERS ?? 100_000);
const BATCH = 5_000;

const client = new pg.Client({ connectionString: DATABASE_URL });

const products = [
  'Wireless Mouse', 'Mechanical Keyboard', 'USB-C Hub', 'Webcam 1080p',
  'Desk Lamp', 'Monitor Stand', 'Cable Organizer', 'Laptop Sleeve',
  'Bluetooth Speaker', 'Noise-Cancelling Headphones', 'Ergonomic Chair',
  'Standing Desk Mat', 'Wrist Rest', 'Screen Cleaner Kit', 'HDMI Cable',
];

async function seed() {
  await client.connect();

  console.log(`Seeding ${TARGET_ORDERS.toLocaleString()} orders...\n`);
  console.time('total');

  await client.query('TRUNCATE line_items, orders, customers RESTART IDENTITY CASCADE');

  // Customers — 1 per 50 orders, so ~2K for 100K orders
  const numCustomers = Math.max(100, Math.floor(TARGET_ORDERS / 50));
  const emails = Array.from({ length: numCustomers }, (_, i) => `customer${i}@example.com`);
  const names = Array.from({ length: numCustomers }, (_, i) => `Customer ${i}`);
  await client.query(
    'INSERT INTO customers (email, name) SELECT * FROM UNNEST($1::text[], $2::text[])',
    [emails, names],
  );
  console.log(`  customers: ${numCustomers.toLocaleString()}`);

  // Orders — batch insert
  let orderIdCursor = 1;
  for (let offset = 0; offset < TARGET_ORDERS; offset += BATCH) {
    const size = Math.min(BATCH, TARGET_ORDERS - offset);
    const customerIds: number[] = [];
    const statuses: string[] = [];
    const totals: number[] = [];
    for (let i = 0; i < size; i++) {
      customerIds.push(Math.floor(Math.random() * numCustomers) + 1);
      statuses.push(Math.random() > 0.1 ? 'shipped' : 'pending');
      totals.push(Math.floor(Math.random() * 50000) + 1000);
    }
    await client.query(
      'INSERT INTO orders (customer_id, status, total_cents) SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::int[])',
      [customerIds, statuses, totals],
    );

    // Line items — 1 to 5 per order in this batch
    const orderIds: number[] = [];
    const productNames: string[] = [];
    const quantities: number[] = [];
    const prices: number[] = [];
    for (let i = 0; i < size; i++) {
      const orderId = orderIdCursor + i;
      const numItems = Math.floor(Math.random() * 5) + 1;
      for (let j = 0; j < numItems; j++) {
        orderIds.push(orderId);
        productNames.push(products[Math.floor(Math.random() * products.length)]!);
        quantities.push(Math.floor(Math.random() * 3) + 1);
        prices.push(Math.floor(Math.random() * 5000) + 500);
      }
    }
    await client.query(
      'INSERT INTO line_items (order_id, product_name, quantity, unit_price_cents) SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::int[], $4::int[])',
      [orderIds, productNames, quantities, prices],
    );

    orderIdCursor += size;
    process.stdout.write(`\r  orders: ${orderIdCursor - 1}/${TARGET_ORDERS}`);
  }

  console.log('\n');
  console.timeEnd('total');
  await client.end();
}

seed().catch((err) => {
  console.error('\nSeed failed:', err);
  process.exit(1);
});
