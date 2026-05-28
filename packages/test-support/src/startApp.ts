/**
 * `startApp` — boot the codex `app-server` against an isolated CODEX_HOME
 * (a tmpdir, set via `extraEnv.CODEX_HOME`), open a JSON-RPC WebSocket
 * transport, perform the `initialize` handshake, and call `thread/start`.
 *
 * Test fixture only. Production wiring of the daemon arrives in phase 4.
 *
 * Wire-shape contract (verified at codex-rs commit `127434cd8b96`):
 *
 * - `initialize` params use `clientInfo` (camelCase), not `client_info`. See
 *   `app-server-protocol/src/protocol/common.rs:1856` for the wire literal.
 * - `thread/start` params accept optional `dynamicTools` (camelCase) and
 *   `baseInstructions`. The response envelope is `{ thread: { id, ... } }`
 *   (NOT `{ thread_id }`).
 *
 * Model-override path: when `modelBaseUrl` is set, codex's `-c` CLI
 * overrides declare a custom provider (`name`, `base_url`,
 * `wire_api = "responses"`) and select it via `model_provider`. Tests use
 * this with `startMockModel` to replay deterministic SSE turns instead of
 * hitting the real OpenAI API.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  JsonRpcClient,
  METHOD,
  connectWs,
  escapeTomlBasicString,
  spawnAppServer,
  type AppServerHandle,
  type DynamicToolDef,
  type ThreadStartResponse,
} from '@aharness/core/runtime';

export interface StartAppOptions {
  /**
   * Optional override for codex's model provider base URL. When present,
   * the spawned app-server gets `-c model_provider="mock"` plus matching
   * `-c model_providers.mock.*` entries pointing at this URL. Pair with
   * `startMockModel()` to feed codex deterministic SSE turns.
   */
  readonly modelBaseUrl?: string;
  /**
   * Dynamic tools to declare on the thread via `thread/start.dynamicTools`.
   * Defaults to `[]`. Production callers (Task 35+) pass the SUBMIT_TOOL
   * registry; Task 14 only plumbs the array through.
   */
  readonly dynamicTools?: ReadonlyArray<DynamicToolDef>;
}

export interface AppHandle {
  readonly threadId: string;
  readonly client: JsonRpcClient;
  readonly tmpDir: string;
  readonly server: AppServerHandle;
  close(): Promise<void>;
}

export async function startApp(opts: StartAppOptions = {}): Promise<AppHandle> {
  const tmp = mkdtempSync(join(tmpdir(), 'h-app-'));
  const codexHome = join(tmp, 'codex_home');
  // codex's own startup expects CODEX_HOME to exist on disk; pre-create
  // it so the app-server does not bail with `CODEX_HOME points to ...`.
  mkdirSync(codexHome, { recursive: true });

  const cliOverrides: Array<[string, string]> = [];
  if (opts.modelBaseUrl !== undefined) {
    cliOverrides.push(
      ['model_provider', '"mock"'],
      ['model_providers.mock.name', '"mock"'],
      ['model_providers.mock.base_url', escapeTomlBasicString(opts.modelBaseUrl)],
      ['model_providers.mock.wire_api', '"responses"'],
    );
  }

  let server: AppServerHandle | undefined;
  let client: JsonRpcClient | undefined;
  try {
    server = await spawnAppServer({
      extraEnv: { CODEX_HOME: codexHome },
      cliOverrides,
    });
    const transport = await connectWs(server.wsUrl);
    client = new JsonRpcClient(transport);

    // Verified wire shape: `clientInfo` (camelCase). See header comment.
    // `capabilities.experimentalApi` opts the client into experimental
    // surfaces; `thread/start.dynamicTools` is gated on it (codex error
    // -32600 "dynamicTools requires experimentalApi capability" otherwise).
    await client.request(METHOD.initialize, {
      clientInfo: { name: '@aharness/test-support', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });

    const startRes = await client.request<ThreadStartResponse>(METHOD.threadStart, {
      dynamicTools: opts.dynamicTools ?? [],
    });
    const threadId = startRes.thread.id;

    const liveServer = server;
    const liveClient = client;
    return {
      threadId,
      client: liveClient,
      tmpDir: tmp,
      server: liveServer,
      async close() {
        try {
          await liveClient.close();
        } catch {
          /* best-effort during teardown */
        }
        await liveServer.close();
        rmSync(tmp, { recursive: true, force: true });
      },
    };
  } catch (e) {
    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        /* swallow during error path */
      }
    }
    if (server !== undefined) {
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
