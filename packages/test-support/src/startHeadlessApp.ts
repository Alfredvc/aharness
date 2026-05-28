/**
 * `startHeadlessApp` — Phase 1 integration-test fixture.
 *
 * Spawns a real codex `app-server` against a temp `CODEX_HOME`, opens
 * the WS-over-Unix client via `connectHeadlessWs`, sends `initialize`
 * with the shared `PHASE1_OPT_OUT_METHODS` opt-out list (spec §5.7),
 * and calls `thread/start({dynamicTools: [SUBMIT_TOOL]})` so the
 * model-side tool surface mirrors what `runCli` registers.
 *
 * NOT a production-runtime construct — the CLI (`cli/runCli.ts`)
 * assembles the same boot sequence inline. This helper centralises the
 * fixture wiring for Phase 1 integration tests that need a live
 * app-server + threadId pair without the FSM/daemon-side machinery.
 *
 * Wire-shape contract (mirrors `runCli.ts` and `startApp.ts`):
 *
 * - Pre-creates `CODEX_HOME` on disk before spawn (codex bails if the
 *   directory does not exist).
 * - Custom mock-model provider injection mirrors `startApp.ts`: when
 *   `modelBaseUrl` is set, the spawn gets `-c model_provider="mock"`
 *   plus `-c model_providers.mock.*` overrides.
 * - `default_mode_request_user_input` feature is enabled so codex's
 *   built-in `request_user_input` tool is available (parity with
 *   `runCli.ts:325`).
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DAEMON_PROBE_CLIENT_NAME,
  JsonRpcClient,
  METHOD,
  PHASE1_OPT_OUT_METHODS,
  buildDynamicToolsRegistration,
  connectHeadlessWs,
  escapeTomlBasicString,
  spawnAppServer,
  type AppServerHandle,
  type ThreadStartResponse,
} from '@aharness/core/runtime';

export interface StartHeadlessAppOptions {
  /** Pre-allocated socket path. Required. */
  readonly sockPath: string;
  /** Pass through to codex (mock model base URL). */
  readonly modelBaseUrl?: string;
  /** Notification methods to opt out of. Defaults to PHASE1_OPT_OUT_METHODS. */
  readonly optOutNotificationMethods?: ReadonlyArray<string>;
}

export interface HeadlessAppHandle {
  readonly threadId: string;
  readonly client: JsonRpcClient;
  readonly server: AppServerHandle;
  readonly tmpDir: string;
  close(): Promise<void>;
}

export async function startHeadlessApp(o: StartHeadlessAppOptions): Promise<HeadlessAppHandle> {
  const tmp = mkdtempSync(join(tmpdir(), 'h-hl-'));
  const codexHome = join(tmp, 'codex_home');
  mkdirSync(codexHome, { recursive: true });

  const cliOverrides: Array<[string, string]> = [];
  if (o.modelBaseUrl !== undefined) {
    cliOverrides.push(
      ['model_provider', '"mock"'],
      ['model_providers.mock.name', '"mock"'],
      ['model_providers.mock.base_url', escapeTomlBasicString(o.modelBaseUrl)],
      ['model_providers.mock.wire_api', '"responses"'],
    );
  }

  let server: AppServerHandle | undefined;
  let wsHandle: Awaited<ReturnType<typeof connectHeadlessWs>> | undefined;
  try {
    server = await spawnAppServer({
      sockPath: o.sockPath,
      extraEnv: { CODEX_HOME: codexHome },
      cliOverrides,
      enabledFeatures: ['default_mode_request_user_input'],
    });
    wsHandle = await connectHeadlessWs({
      sockPath: o.sockPath,
      clientInfo: { name: DAEMON_PROBE_CLIENT_NAME, version: '0.0.0' },
      optOutNotificationMethods: o.optOutNotificationMethods ?? PHASE1_OPT_OUT_METHODS,
    });
    const startRes = await wsHandle.client.request<ThreadStartResponse>(METHOD.threadStart, {
      dynamicTools: buildDynamicToolsRegistration(),
    });
    const threadId = startRes.thread.id;
    const liveServer = server;
    const liveHandle = wsHandle;
    return {
      threadId,
      client: liveHandle.client,
      server: liveServer,
      tmpDir: tmp,
      async close() {
        try {
          await liveHandle.close();
        } catch {
          /* best-effort during teardown */
        }
        await liveServer.close();
        rmSync(tmp, { recursive: true, force: true });
      },
    };
  } catch (e) {
    if (wsHandle) {
      try {
        await wsHandle.close();
      } catch {
        /* swallow during error path */
      }
    }
    if (server) {
      try {
        await server.close();
      } catch {
        /* swallow during error path */
      }
    }
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}
