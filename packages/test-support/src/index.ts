/**
 * `@aharness/test-support` — test fixtures for `@aharness/core`.
 *
 * Exports:
 * - SSE encoders for the OpenAI Responses-API stream (`./sse.js`),
 *   including `encodeFunctionCallTurn` for single-function-call turns
 *   consumed by `MockModelHandle.queueTurn` callers.
 * - A mock-model HTTP server that replays queued SSE turns (`./mockModel.js`).
 * - `startApp` — boot a real codex `app-server` against an ephemeral
 *   `CODEX_HOME`, perform the JSON-RPC handshake, and return a live
 *   `AppHandle`. Pair with `startMockModel` to keep tests deterministic.
 * - `submitTurn` — push a user prompt and await `turn/completed`.
 * - `waitForState` — generic polling helper (R17) for state-machine waits.
 * - `waitForTransition`, `currentState`, `lastSnapshot` — daemon-aware stubs
 *   that throw until phase-4 wiring lands; exported so downstream tasks
 *   can compile against the barrel today.
 */

export const PACKAGE_NAME = '@aharness/test-support' as const;
export * from './sse.js';
export { startMockModel, type MockModelHandle } from './mockModel.js';
export { startApp, type StartAppOptions, type AppHandle } from './startApp.js';
export {
  startHeadlessApp,
  type StartHeadlessAppOptions,
  type HeadlessAppHandle,
} from './startHeadlessApp.js';
export { submitTurn } from './submitTurn.js';
export { waitForState } from './waitForState.js';
export { waitForTransition } from './waitForTransition.js';
export { currentState } from './currentState.js';
export { lastSnapshot } from './lastSnapshot.js';
export { spawnPty, type PtyHandle, type SpawnPtyOptions } from './pty.js';
export {
  REQUIREMENT_SPEC_SHORTEST_WALK,
  buildAssistantTurnForOwnerText,
  buildSubmitTurn,
  type WalkStep,
} from './fixtures/requirementSpecWalk.js';
export {
  CROSS_STATE_WALK_FSM_SOURCE,
  buildCrossStateSubmitTurn,
  crossStateWalkMachine,
} from './fixtures/crossStateWalk.js';
export { AWAIT_EXIT_WALK_FSM_SOURCE, awaitExitWalkMachine } from './fixtures/awaitExitWalk.js';
export { HOOK_WALK_FSM_SOURCE, hookWalkMachine } from './fixtures/hookWalk.js';
export { EMBED_REGRESSION_FSM_SOURCE, embedRegressionMachine } from './fixtures/embedRegression.js';
export {
  OWNER_YIELD_WALK_FSM_SOURCE,
  buildRequestUserInputTurn,
  ownerYieldWalkMachine,
} from './fixtures/ownerYieldWalk.js';
export {
  CLEAR_WALK_FSM_SOURCE,
  buildClearWalkSubmitTurn,
  clearWalkMachine,
} from './fixtures/clearWalk.js';
export {
  createMockOwnerInputProvider,
  type MockOwnerInputProvider,
  type MockOwnerInputResponder,
  type MockOwnerInputStaticAnswers,
} from './mockOwnerInputProvider.js';
