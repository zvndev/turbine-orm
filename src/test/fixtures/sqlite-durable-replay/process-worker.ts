import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { command, loadApplication, open } from './contracts.js';

async function main() {
  const { SqliteOrderReplay, appendWithAdmissionRetry, initializeDestination, recordEffect } = await loadApplication();
  const [mode, path, marker, gate] = process.argv.slice(2);
  assert.ok(mode && path && marker && gate);
  const raw = open(path);
  const app = new SqliteOrderReplay(raw, { batchSize: 2, deadlineMs: 1000 });
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('owned worker stopped'));
  process.once('SIGTERM', stop);
  const wait = async () => {
    for (let n = 0; n < 400 && !existsSync(gate); n++) {
      abort.signal.throwIfAborted();
      await delay(5);
    }
    abort.signal.throwIfAborted();
    assert.ok(existsSync(gate), 'Bounded worker gate exhausted');
  };
  try {
    if (mode === 'append') {
      writeFileSync(marker, 'ready');
      await wait();
      const event = await appendWithAdmissionRetry(
        app,
        command(Number(process.argv[6] ?? 100), 'process'),
        abort.signal,
      );
      writeFileSync(marker, JSON.stringify(event));
    } else if (mode === 'uncommitted') {
      // Native trigger exits AFTER business/outbox insertion but BEFORE transaction COMMIT.
      raw.function('interrupt_after_insert', () => {
        writeFileSync(marker, 'written-before-commit');
        process.exit(73);
      });
      raw.exec(`CREATE TEMP TRIGGER interrupt_insert AFTER INSERT ON main.replay_outbox
        BEGIN SELECT interrupt_after_insert(); END`);
      await app.append(command(200, 'uncommitted'));
      assert.fail('Expected actual process exit in native trigger');
    } else if (mode === 'committed') {
      await app.append(command(201, 'committed'));
      writeFileSync(marker, 'committed');
      // Deliberate abrupt exit leaves no application close or native handle.close.
      process.exit(74);
    } else if (mode === 'consume-hold') {
      await app.consumeBatch(
        'process',
        'shared',
        async (event) => {
          writeFileSync(marker, event.position);
          await wait();
        },
        abort.signal,
      );
      writeFileSync(marker, 'acknowledged');
    } else if (mode === 'effect-crash') {
      const sink = open(gate);
      try {
        initializeDestination(sink);
        await app.consumeBatch('process', 'effect-crash', (event, signal) => {
          recordEffect(sink, 'effect-crash', event, signal);
          writeFileSync(marker, 'destination-committed-before-checkpoint');
          process.exit(75);
        });
      } finally {
        sink.close();
      }
    } else throw new Error('Unknown worker mode');
  } finally {
    await app.close();
    raw.close();
    process.removeListener('SIGTERM', stop);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
