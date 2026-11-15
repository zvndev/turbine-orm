import type {
  NotificationHubHandler,
  NotificationHubSubscribeOptions,
  NotificationResyncReason,
} from '../notification-hub.js';

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** No payload queue: one handler and one lifecycle observer per consumer. */
export class ConsumerDelivery {
  active = true;
  private handling = false;
  private observing = false;
  private overflow = false;
  private reconnect = false;
  private resync = false;
  private error: Error | undefined;

  constructor(
    private readonly handler: NotificationHubHandler,
    private readonly options: NotificationHubSubscribeOptions,
    private readonly fallback: (error: Error) => void,
  ) {}

  stop(): void {
    this.active = false;
    this.error = undefined;
    this.overflow = this.reconnect = this.resync = false;
  }

  deliver(payload: string): void {
    if (!this.active) return;
    if (this.handling) {
      this.overflow = true;
      return;
    }
    try {
      const result = this.handler(payload);
      if (result && typeof result.then === 'function') {
        this.handling = true;
        void Promise.resolve(result)
          .catch((error: unknown) => this.report(asError(error)))
          .finally(() => {
            this.handling = false;
            this.flush();
          });
      }
    } catch (error) {
      this.report(asError(error));
    }
  }

  report(error: Error): void {
    if (!this.active) return;
    if (!this.options.onError) {
      this.fallback(error);
      return;
    }
    this.error = error;
    this.flush();
  }

  restored(): void {
    if (!this.active) return;
    this.reconnect = this.resync = true;
    this.flush();
  }

  private flush(): void {
    if (!this.active || this.observing) return;
    this.observing = true;
    void this.observe().finally(() => {
      this.observing = false;
      if (this.active && (this.error || this.reconnect || this.resync || (!this.handling && this.overflow)))
        this.flush();
    });
  }

  private async observe(): Promise<void> {
    while (this.active) {
      let callback: (() => void | Promise<void>) | undefined;
      if (this.error) {
        const error = this.error;
        this.error = undefined;
        callback = () => this.options.onError?.(error);
      } else if (this.reconnect) {
        this.reconnect = false;
        callback = this.options.onReconnect;
      } else if (this.resync || (!this.handling && this.overflow)) {
        const reason: NotificationResyncReason = this.resync ? 'reconnect' : 'overflow';
        if (this.resync) this.resync = false;
        else this.overflow = false;
        callback = () => this.options.onResync?.(reason);
      } else {
        return;
      }
      try {
        await callback?.();
      } catch (error) {
        this.fallback(asError(error));
      }
    }
  }
}
