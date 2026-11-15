import { type LiveQuery, liveQuery } from 'turbine-orm/live-query';
import { createNotificationHub, type NotificationHubOptions } from 'turbine-orm/notification-hub';

/** Application-local composition, not a new ORM API. The caller owns the pool. */
export function createApplication(options: {
  pool: Parameters<typeof createNotificationHub>[0];
  endpoint: NotificationHubOptions['endpoint'];
  channel: string;
  onDiagnostic(error: Error): void;
}) {
  const hub = createNotificationHub(options.pool, {
    endpoint: options.endpoint,
    ownership: 'external',
    maxChannels: 1,
    maxSubscriptions: 64,
    reconnect: { initialDelayMs: 25, maxDelayMs: 1000 },
    onError: options.onDiagnostic,
  });
  const shutdown = new AbortController();
  const handles = new Set<LiveQuery<unknown>>();
  const reads = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;

  return {
    hub,
    watch<T>(query: (signal: AbortSignal) => T | PromiseLike<T>, requestSignal?: AbortSignal): LiveQuery<Awaited<T>> {
      if (shutdown.signal.aborted) throw new Error('Application is closing');
      if (handles.size >= 64) throw new Error('Application query limit (64) exceeded');
      const ownReads = new Set<Promise<unknown>>();
      const signal = requestSignal ? AbortSignal.any([shutdown.signal, requestSignal]) : shutdown.signal;
      const snapshots = liveQuery({
        signal,
        query: (querySignal) => {
          const read = Promise.resolve().then(() => {
            querySignal.throwIfAborted();
            // Capture authorized scope in query. Notifications are not authorization.
            return query(querySignal);
          });
          reads.add(read);
          ownReads.add(read);
          void read.then(
            () => {
              reads.delete(read);
              ownReads.delete(read);
            },
            () => {
              reads.delete(read);
              ownReads.delete(read);
            },
          );
          return read;
        },
        // Await LISTEN acknowledgement BEFORE liveQuery schedules its first read.
        subscribe: async (invalidate) => {
          try {
            return await hub.subscribe(options.channel, invalidate, {
              signal,
              // Reconnect and async-handler overflow both require a fresh current snapshot.
              onResync: () => invalidate(),
              // Hub errors can be recoverable. Never forward these to terminal LiveQuery.onError.
              onError: options.onDiagnostic,
            });
          } catch (error) {
            // hub removes a cancelled pending registration itself. Give liveQuery a
            // cleanup handle so request cancellation during setup remains graceful.
            // Application.close still waits for the hub's finite late checkout.
            if (signal.aborted) return { unsubscribe() {} };
            throw error;
          }
        },
      });
      handles.add(snapshots);
      const releaseSlot = async () => {
        // Cancelled queries retain their slot until their finite SQL settles too.
        await Promise.allSettled([...ownReads]);
        handles.delete(snapshots);
      };
      void snapshots.closed.then(releaseSlot, releaseSlot);
      return snapshots;
    },
    close(): Promise<void> {
      if (closing) return closing;
      const active = [...handles];
      shutdown.abort(); // Also cancels pending hub.subscribe readiness.
      closing = (async () => {
        const results = await Promise.allSettled(active.map((handle) => handle.dispose()));
        // liveQuery.dispose does not wait for ordinary SQL that ignores AbortSignal.
        // Drain it here, before the caller ends its pool. Set finite driver query timeouts.
        await Promise.allSettled([...reads]);
        try {
          await hub.close();
        } catch (error) {
          results.push({ status: 'rejected', reason: error });
        }
        const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
        if (failures.length) throw new AggregateError(failures, 'Application shutdown failed');
      })();
      return closing;
    },
  };
}
