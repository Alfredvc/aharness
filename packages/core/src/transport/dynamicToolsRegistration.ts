/**
 * Build the `dynamic_tools` array sent on `thread/start`. Spec §4.3.1.
 *
 * Phase 1 ships exactly the frozen `SUBMIT_TOOL` constant. The
 * description and inputSchema MUST stay byte-identical — codex derives
 * the prompt-cache key from the `dynamicTools` payload (spec §10), so any
 * drift evicts the cache and forces the model to re-prefill the full
 * conversation. Centralising the registration through this helper keeps
 * every emitter in lockstep with `SUBMIT_TOOL`'s frozen bytes.
 */
import { SUBMIT_TOOL } from '../protocol/submitTool.js';
import type { DynamicToolDef } from '../protocol/types.js';

export function buildDynamicToolsRegistration(): ReadonlyArray<DynamicToolDef> {
  return [SUBMIT_TOOL];
}
