import type { TestContext } from 'node:test';
import type { turbineNeonWs, withNeonWs } from '../../../neon-ws.js';
import type { createNotificationHub } from '../../../notification-hub.js';
export function poolerContract(
  api: {
    createNotificationHub: typeof createNotificationHub;
    turbineNeonWs: typeof turbineNeonWs;
    withNeonWs: typeof withNeonWs;
  },
  test: TestContext,
  scope: string,
): Promise<void>;
