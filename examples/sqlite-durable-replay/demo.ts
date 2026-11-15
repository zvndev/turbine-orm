import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeDestination, recordEffect } from './destination.js';
import { appendWithAdmissionRetry, SqliteOrderReplay } from './replay.js';

async function main() {
  const directory = process.argv[2];
  if (!directory) throw new Error('Pass an application-owned local directory');
  const root = resolve(directory);
  mkdirSync(root, { recursive: true });
  const path = resolve(root, 'orders.db'), destination = resolve(root, 'destination.db');
  const fresh = !existsSync(path), freshDestination = !existsSync(destination);
  // The demo owns these handles. The workflow itself only validates these settings.
  const raw = new DatabaseSync(path), sink = new DatabaseSync(destination);
  const stop = new AbortController();
  const interrupted = () => stop.abort(new Error('Demo interrupted'));
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  let app: SqliteOrderReplay | undefined;
  try {
    for (const handle of [raw, sink]) handle.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=0');
    app = new SqliteOrderReplay(raw);
    if (fresh) await app.initialize(stop.signal);
    if (freshDestination) initializeDestination(sink);
    for (let n = 0; n < 3; n++) await appendWithAdmissionRetry(app, {
      tenant: 'shop', eventId: `stable-event-${n}`, orderId: `order-${n}`, title: n === 0 ? null : '雪',
      quantity: '9007199254740993', amount: '12.3400', occurredAt: '2024-02-29T12:34:56.123456Z',
      body: Uint8Array.of(0, 255, n),
    }, stop.signal);
    const progress = app.reconcile('shop', 'invoices', (event, signal) => recordEffect(sink, 'invoices', event, signal), stop.signal);
    try {
      for await (const count of progress) {
        console.log(JSON.stringify({ committedBatchObservation: count }));
        if (count === 0) break;
      }
    } finally { await progress.return(undefined); }
    console.log(JSON.stringify({ checkpoint: await app.checkpoint('shop', 'invoices', stop.signal),
      destinationRows: sink.prepare('SELECT count(*) AS n FROM effects').get()?.n }));
  } finally {
    await app?.close(); sink.close(); raw.close();
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
