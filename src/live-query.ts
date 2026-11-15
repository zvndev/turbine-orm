/** Optional notification-driven snapshots. No client or driver is imported. */

/** Owned listener handle. A rejected subscribe must clean up its own partial setup. */
export interface LiveQuerySubscription {
  unsubscribe(): void | PromiseLike<void>;
}

export interface LiveQuerySubscriptionCallbacks {
  /** Called after listening is active again; forces a fresh snapshot. */
  onReconnect(): void;
  /** Terminal failure only. Retryable transport loss belongs to the listener. */
  onError(error: unknown): void;
}

export interface LiveQueryOptions<T> {
  /** Run the ordinary caller query, retaining its policies and result type. */
  query(signal: AbortSignal): T | PromiseLike<T>;
  /** Must resolve only after listening is active. Called once per live query. */
  subscribe(
    invalidate: () => void,
    callbacks: LiveQuerySubscriptionCallbacks,
  ): LiveQuerySubscription | PromiseLike<LiveQuerySubscription>;
  signal?: AbortSignal;
}

/** Single consumer, latest snapshots, with at most one pending next() call. */
export interface LiveQuery<T> extends AsyncIterableIterator<T> {
  /** Listening is active and the first query has been scheduled. */
  readonly ready: Promise<void>;
  /** Listener cleanup finished. Rejects on query, subscription or cleanup failure. */
  readonly closed: Promise<void>;
  /** Stops delivery/reruns immediately; waits for listener setup and cleanup. */
  dispose(): Promise<void>;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/**
 * Subscribe before reading; rerun after invalidation or reconnect. Memory is
 * bounded to one query, one dirty bit, one result and one pending pull. Dirty
 * snapshots are discarded; slow consumers receive the newest clean snapshot.
 */
export function liveQuery<T>(options: LiveQueryOptions<T>): LiveQuery<Awaited<T>> {
  const controller = new AbortController();
  const ready = deferred<void>();
  const closed = deferred<void>();
  // Lifecycle promises may be ignored by consumers using only for-await.
  void ready.promise.catch(() => {});
  void closed.promise.catch(() => {});

  let stopped = false;
  let running = false;
  let listening = false;
  let dirty = false;
  let latest: { value: Awaited<T> } | undefined;
  let pending: ReturnType<typeof deferred<IteratorResult<Awaited<T>>>> | undefined;
  let failure: { error: unknown } | undefined;

  const finishPull = (): void => {
    if (!pending) return;
    const pull = pending;
    pending = undefined;
    if (failure) pull.reject(failure.error);
    else pull.resolve({ done: true, value: undefined });
  };

  const stop = (error?: { error: unknown }): Promise<void> => {
    if (stopped) return closed.promise;
    stopped = true;
    failure = error;
    latest = undefined;
    dirty = false;
    options.signal?.removeEventListener('abort', onAbort);
    ready.reject(error ? error.error : new DOMException('Live query closed before ready', 'AbortError'));
    controller.abort(error?.error);
    finishPull();
    // Observe setup even when cancellation or a callback closes during setup.
    void subscriptionTask.then(
      async (subscription) => {
        try {
          await subscription?.unsubscribe();
        } catch (cleanupError) {
          failure = {
            error: failure
              ? new AggregateError([failure.error, cleanupError], 'Live query and listener cleanup failed')
              : cleanupError,
          };
        }
        if (failure) closed.reject(failure.error);
        else closed.resolve();
      },
      (setupError: unknown) => {
        failure ??= { error: setupError };
        closed.reject(failure.error);
      },
    );
    return closed.promise;
  };

  const run = async (): Promise<void> => {
    running = true;
    try {
      while (!stopped && dirty) {
        dirty = false;
        const value = await options.query(controller.signal);
        if (stopped) return;
        if (dirty) continue;
        if (pending) {
          const pull = pending;
          pending = undefined;
          pull.resolve({ done: false, value });
        } else latest = { value };
      }
    } catch (error) {
      if (!stopped) void stop({ error });
    } finally {
      running = false;
    }
  };

  const invalidate = (): void => {
    if (stopped) return;
    dirty = true;
    latest = undefined;
    if (listening && !running) void run();
  };
  const onAbort = (): void => {
    void stop();
  };

  // Defer user code until all lifecycle state exists, including subscriptionTask.
  const subscriptionTask = Promise.resolve().then(async () => {
    if (stopped) return undefined;
    const subscription = await options.subscribe(invalidate, {
      onReconnect: invalidate,
      onError: (error) => {
        void stop({ error });
      },
    });
    if (!subscription || typeof subscription.unsubscribe !== 'function') {
      throw new TypeError('Live query subscribe must return an unsubscribe handle');
    }
    return subscription;
  });
  void subscriptionTask.then(
    () => {
      if (stopped) return;
      listening = true;
      invalidate();
      ready.resolve();
    },
    (error: unknown) => {
      if (!stopped) void stop({ error });
    },
  );

  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  const result: LiveQuery<Awaited<T>> = {
    ready: ready.promise,
    closed: closed.promise,
    dispose: () => stop(),
    [Symbol.asyncIterator]: () => result,
    next(): Promise<IteratorResult<Awaited<T>>> {
      if (stopped) {
        return failure ? Promise.reject(failure.error) : Promise.resolve({ done: true, value: undefined });
      }
      if (pending) return Promise.reject(new TypeError('Live query permits only one pending next()'));
      if (latest) {
        const value = latest.value;
        latest = undefined;
        return Promise.resolve({ done: false, value });
      }
      pending = deferred<IteratorResult<Awaited<T>>>();
      return pending.promise;
    },
    async return(): Promise<IteratorResult<Awaited<T>>> {
      await stop();
      return { done: true, value: undefined };
    },
    async throw(error: unknown): Promise<IteratorResult<Awaited<T>>> {
      await stop({ error });
      throw error;
    },
  };
  return result;
}
