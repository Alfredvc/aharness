/**
 * Phase 1 two-process shutdown (spec §4.1, headless transport backbone).
 *
 * On SIGTERM the CLI tears down its children in this order:
 *
 *   1. Transition handling records canonical run events as it goes;
 *      `runShutdown` performs teardown only and does not write a derived
 *      state snapshot.
 *   2. Close the WS client first so codex stops emitting notifications
 *      to a half-shutdown handler. Closing the client drops the
 *      `accept()`ed Unix-domain socket; codex observes the close and
 *      stops writing further `ServerNotification` frames.
 *   3. `AppServerHandle.close()` SIGTERMs the app-server child and
 *      escalates to SIGKILL after a 2 s grace (escalation lives in
 *      `appServer/spawn.ts`).
 *   4. Reap `<runDir>/app-server.sock` and `<runDir>/hook.sock` if they
 *      survived the children's own cleanup.
 *
 * Phase 1 has no HTTP server (Phase 3) and no `thread/unsubscribe`
 * method at the pinned commit — both are deferred.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import type { AppServerHandle } from '../appServer/index.js';
import type { JsonRpcClient } from '../jsonrpc/client.js';
import type { RunDir } from '../types.js';

import type { OwnerInputProvider } from './ownerInputProvider.js';

export interface RunShutdownOpts {
  readonly appServer: AppServerHandle;
  readonly client: JsonRpcClient;
  readonly runDir: RunDir;
  /**
   * Optional Phase-2b owner-yield provider. When set, `runShutdown`
   * invokes `provider.close?.()` AFTER `appServer.close()` resolves and
   * BEFORE the socket-reap loop so the stdin reader (production) or
   * close-call accounting (tests) releases on every shutdown route.
   * Best-effort: errors are swallowed so a provider bug cannot block
   * socket cleanup.
   */
  readonly ownerInputProvider?: OwnerInputProvider;
}

export async function runShutdown(o: RunShutdownOpts): Promise<void> {
  // 1. Close WS first so codex stops emitting notifications to us.
  try {
    await o.client.close();
  } catch {
    /* best-effort — proceed to app-server teardown regardless. */
  }
  // 2. SIGTERM the app-server child. AppServerHandle.close() handles the
  //    SIGTERM-then-SIGKILL escalation (2 s grace) per appServer/spawn.ts.
  await o.appServer.close();
  // 3. Release the owner-input provider's resources (if any). Phase-2b
  //    contract: every shutdown route closes the provider exactly once
  //    so the stdin readline interface does not block process exit.
  try {
    o.ownerInputProvider?.close?.();
  } catch {
    /* best-effort */
  }
  // 4. Reap the per-run sockets if codex didn't.
  for (const f of ['app-server.sock', 'hook.sock']) {
    try {
      rmSync(join(o.runDir.root, f), { force: true });
    } catch {
      /* best-effort */
    }
  }
}
