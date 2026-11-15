import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool as MysqlPool } from 'mysql2/promise';
import type pg from 'pg';
import { capture, openOrderApplication } from '../mysql-durable-replay/application.js';
import { createOrderApplication, type OrderCommand, type OrderEvent } from '../postgres-durable-replay/application.js';

export type { OrderCommand, OrderEvent } from '../postgres-durable-replay/application.js';

export interface RelayOptions {
  sourcePool: pg.Pool;
  targetPool: MysqlPool;
  schema: string;
  /** Stable UUID for exactly one database/schema history. Never reuse after a history reset/fork. */
  sourceHistoryId: string;
  /** 1..27 ASCII key characters; bound to sourceHistoryId at both stores. */
  consumer: string;
  endpoint: 'direct' | 'session-pool';
  onDiagnostic(error: Error): void;
  batchSize?: number;
  sqlMs?: number;
  operationMs?: number;
}

const registryKey = Symbol.for('turbine.example.postgres-mysql-relay.v1');
const registry = globalThis as typeof globalThis & { [registryKey]?: AsyncLocalStorage<ReadonlySet<string>> };
const context = (registry[registryKey] ??= new AsyncLocalStorage<ReadonlySet<string>>());
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maximum = 9223372036854775807n;

function bound(value: number, max: number, name: string, min = 1): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid finite ${name}`);
  return value;
}

function scope(value: string, max = 64): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > max)
    throw new TypeError(`Scope requires 1..${max} ASCII key characters`);
  return value;
}

/** Common PG/MySQL domain. The existing target capture reads properties once and copies bytes. */
function commandCopy(input: OrderCommand): OrderCommand {
  const command = capture(input);
  if (!uuid.test(command.eventId) || !uuid.test(command.orderId)) throw new TypeError('Canonical UUIDs required');
  if (command.title?.includes('\0')) throw new TypeError('PostgreSQL titles cannot contain NUL');
  return command;
}

function deliveryCopy(event: OrderEvent, tenant: string): OrderEvent {
  const eventTenant = event.tenant;
  const position = event.position;
  if (scope(eventTenant) !== tenant) throw new TypeError('Source tenant mismatch');
  if (typeof position !== 'string' || !/^[1-9][0-9]{0,18}$/.test(position) || BigInt(position) > maximum)
    throw new TypeError('Source position exceeds positive int8');
  return { ...commandCopy(event), tenant: eventTenant, position };
}

/** Fixed orders-outbox -> inbox/mail_projection application. Pools and provisioning belong to the caller. */
export async function openOrderRelay(options: RelayOptions) {
  const history = options.sourceHistoryId;
  if (typeof history !== 'string' || !uuid.test(history)) throw new TypeError('Canonical sourceHistoryId UUID required');
  const consumer = scope(options.consumer, 27);
  const binding = `${history}_${consumer}`;
  const schema = options.schema;
  const identity = `${history}/${schema}/${consumer}`;
  const batchSize = bound(options.batchSize ?? 16, 32, 'batchSize');
  const sqlMs = bound(options.sqlMs ?? 2500, 3000, 'sqlMs');
  const operationMs = bound(options.operationMs ?? 6000, 10000, 'operationMs');
  const targetOptions = { pool: options.targetPool, batchSize, sqlMs, operationMs };
  const source = createOrderApplication({
    pool: options.sourcePool,
    schema,
    endpoint: options.endpoint,
    onDiagnostic: options.onDiagnostic,
    batchSize,
    callbackMs: 2000,
  });
  let target: Awaited<ReturnType<typeof openOrderApplication>>;
  try {
    target = await openOrderApplication(targetOptions);
  } catch (error) {
    // Cleanup must not replace the original rejection, including a falsy reason.
    await source.close().catch(() => {});
    throw error;
  }
  const shutdown = new AbortController();
  const active = new Set<Promise<unknown>>();
  const targets = new Set<Promise<unknown>>();
  const destinations = new Set<typeof target>();
  let destinationSlots = 0;
  const appKey = Symbol('relay');
  const ownContext = new AsyncLocalStorage<symbol>();
  let closing: Promise<void> | undefined;

  function admit<T>(tenant: string, run: (signal: AbortSignal) => Promise<T>, request?: AbortSignal): Promise<T> {
    if (shutdown.signal.aborted) return Promise.reject(new Error('Relay closing'));
    const key = `${identity}/${tenant}`;
    if (context.getStore()?.has(key)) return Promise.reject(new Error('Recursive relay operation refused'));
    if (active.size >= 8) return Promise.reject(new Error('Relay operation cap (8)'));
    const deadline = new AbortController();
    const signal = AbortSignal.any([shutdown.signal, deadline.signal, ...(request ? [request] : [])]);
    const timer = setTimeout(() => deadline.abort(new Error('Relay operation deadline')), operationMs);
    const inherited = new Set(context.getStore());
    inherited.add(key);
    const task = ownContext.run(appKey, () =>
      context.run(inherited, async () => {
        try {
          signal.throwIfAborted();
          return await run(signal);
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    active.add(task);
    void task.then(
      () => active.delete(task),
      () => active.delete(task),
    );
    return task;
  }

  async function batch(tenant: string, signal: AbortSignal): Promise<number> {
    const pending = new Set<Promise<unknown>>();
    let destination: typeof target | undefined;
    let count = 0;
    let failure: { reason: unknown } | undefined;
    try {
      count = await source.consumeBatch(
        tenant,
        binding,
        async (event, callbackSignal) => {
          callbackSignal.throwIfAborted();
          const copied = deliveryCopy(event, tenant);
          if (!destination) {
            if (destinationSlots >= 8) throw new Error('Relay target wrapper cap (8)');
            destinationSlots++;
            const opening = openOrderApplication(targetOptions).then(
              (app) => { destination = app; destinations.add(app); return app; },
              (error) => { destinationSlots--; throw error; },
            );
            pending.add(opening);
            targets.add(opening);
            void opening.then(
              () => { pending.delete(opening); targets.delete(opening); },
              () => { pending.delete(opening); targets.delete(opening); },
            );
            destination = await opening;
            if (destination.identity !== target.identity) throw new Error('Target database identity changed');
          }
          callbackSignal.throwIfAborted();
          const delivery = destination.deliverToInbox(binding, copied, callbackSignal);
          pending.add(delivery);
          targets.add(delivery);
          void delivery.then(
            () => { pending.delete(delivery); targets.delete(delivery); },
            () => { pending.delete(delivery); targets.delete(delivery); },
          );
          await delivery;
          // A true (inserted) or false (identical receipt) result is a target COMMIT acknowledgement.
          callbackSignal.throwIfAborted();
        },
        signal,
      );
    } catch (reason) {
      failure = { reason };
    }
    // PG bounds its callback wait. A rejected target delivery can still retain
    // private native SQL. Closing this page's wrapper drains that work as well.
    await Promise.allSettled([...pending]);
    if (destination) {
      try {
        await destination.close();
        destinations.delete(destination);
        destinationSlots--;
      } catch (reason) {
        // Keep failed wrappers owned, capped, and visible to final close.
        failure ??= { reason };
      }
    }
    if (failure) throw failure.reason;
    return count;
  }

  return {
    binding,
    sourceHistoryId: history,
    get outstandingTargets() { return targets.size; },
    /** Fresh stores only. MySQL DDL is not atomic; use versioned migrations in deployments. */
    initialize(): Promise<void> {
      return admit('_initialize', async (signal) => {
        await source.initialize();
        signal.throwIfAborted();
        await target.initialize();
        signal.throwIfAborted();
      });
    },
    append(tenant: string, input: OrderCommand, signal?: AbortSignal): Promise<OrderEvent> {
      scope(tenant);
      const command = commandCopy(input);
      return admit(tenant, (request) => source.append(tenant, command, request), signal);
    },
    relayBatch(tenant: string, signal?: AbortSignal): Promise<number> {
      scope(tenant);
      return admit(tenant, (request) => batch(tenant, request), signal);
    },
    /** Finite polling; every page reopens the durable checkpoint. No notification acknowledges anything. */
    reconcile(
      tenant: string,
      options: { maxBatches?: number; intervalMs?: number } = {},
      signal?: AbortSignal,
    ): Promise<number> {
      scope(tenant);
      const maxBatches = bound(options.maxBatches ?? 4, 64, 'maxBatches');
      const intervalMs = bound(options.intervalMs ?? 250, 2000, 'intervalMs', 10);
      return admit(tenant, async (request) => {
        let delivered = 0;
        for (let n = 0; n < maxBatches; n++) {
          request.throwIfAborted();
          delivered += await batch(tenant, request);
          if (n + 1 < maxBatches) {
            try {
              await delay(intervalMs, undefined, { signal: request });
            } catch (error) {
              if (request.aborted && error instanceof Error && error.name === 'AbortError') throw request.reason;
              throw error;
            }
          }
        }
        return delivered;
      }, signal);
    },
    close(): Promise<void> {
      if (ownContext.getStore() === appKey) return Promise.reject(new Error('Close from relay operation refused'));
      if (closing) return closing;
      shutdown.abort(new Error('Relay closing'));
      closing = (async () => {
        await Promise.allSettled([...active]);
        await Promise.allSettled([...targets]);
        const results = await Promise.allSettled([source.close(), target.close(), ...[...destinations].map((app) => app.close())]);
        const errors = results.flatMap((r) => r.status === 'rejected' ? [r.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'Relay close failed');
      })();
      return closing;
    },
  };
}
