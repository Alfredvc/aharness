/**
 * `submitTurn` — push a user prompt into a live `HeadlessAppHandle` and
 * resolve once the corresponding `turn/completed` notification arrives
 * for the parent thread.
 *
 * Phase 1 wire shape: under the sole-WS-client topology, the harness
 * CLI is the only WS subscriber and the model issues a `harness_submit`
 * `dynamic_tools` call on its own turn (not a client-side `submit` RPC).
 * `submitTurn` is therefore just a `turn/start` + `turn/completed` wait
 * helper — there is no second client to mock.
 *
 * The notification subscription is registered **before** the
 * `turn/start` request so a fast-path `turn/completed` cannot be missed.
 */

import { METHOD } from '@aharness/core/runtime';

import type { HeadlessAppHandle } from './startHeadlessApp.js';

export async function submitTurn(
  app: HeadlessAppHandle,
  prompt: string,
  timeoutMs = 30_000,
): Promise<void> {
  const completed = waitForOnce(app.client, METHOD.turnCompleted, app.threadId, timeoutMs);
  await app.client.request(METHOD.turnStart, {
    threadId: app.threadId,
    input: [{ type: 'text', text: prompt }],
  });
  await completed;
}

function waitForOnce(
  client: { onNotification: (m: string, h: (p: unknown) => void) => () => void },
  method: string,
  threadId: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`submitTurn: ${method} not observed within ${timeoutMs}ms`));
    }, timeoutMs);
    const off = client.onNotification(method, (params) => {
      if ((params as { threadId?: string } | null)?.threadId === threadId) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}
