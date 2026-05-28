/**
 * Barrel for the `appServer` module: helpers that own the codex
 * `app-server` child process — port selection, version gate, and the
 * spawn+ready handle.
 */

export { pickEphemeralPort } from './port.js';
export {
  parseCodexVersion,
  compareSemver,
  checkCodexVersion,
  MIN_CODEX_VERSION,
  type VersionGateResult,
} from './version.js';
export {
  spawnAppServer,
  waitForWs,
  type AppServerHandle,
  type SpawnAppServerOptions,
} from './spawn.js';
