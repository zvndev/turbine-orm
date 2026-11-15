import { createNotificationHub, type NotificationHub, type NotificationHubOptions } from 'turbine-orm/notification-hub';

const pool = {
  async connect() {
    return {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
  },
  async end() {},
};
const options: NotificationHubOptions = { endpoint: 'direct', ownership: 'external', maxChannels: 10 };
const hub: NotificationHub = createNotificationHub(pool, options);
const subscription = hub.subscribe(
  'Orders',
  async (payload: string) => {
    void payload;
  },
  {
    signal: new AbortController().signal,
    onError(error) {
      const value: Error = error;
      void value;
    },
    onReconnect() {},
    onResync(reason) {
      const value: 'reconnect' | 'overflow' = reason;
      void value;
    },
  },
);
void subscription.then((value) => {
  const name: string = value.channel;
  void name;
  return value.unsubscribe();
});
void hub.stats.channels;
void hub.close();
// @ts-expect-error transaction pooling cannot admit LISTEN
createNotificationHub(pool, { endpoint: 'transaction-pool' });
