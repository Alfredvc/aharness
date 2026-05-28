/**
 * Frozen `SUBMIT_TOOL` constant — the single dynamic tool the harness
 * declares at `thread/start.dynamicTools` (per design §10's prompt-cache
 * invariant). Multiple call sites need this exact bytes-for-bytes
 * declaration; centralising it here keeps every emitter in lockstep so
 * the cache key the codex `app-server` derives from `dynamicTools` stays
 * stable across the run.
 *
 * Wire-shape note: the field carrying the JSON Schema is `inputSchema`
 * (verified at the pinned codex commit — see
 * `packages/core/src/protocol/types.ts:50` `DynamicToolDef`). The
 * original migration plan's R7 snippet used `parameters`; that name does
 * not exist on the wire. Use `inputSchema` here.
 *
 * Stability guard: `packages/core/test/protocol.submitTool.test.ts`
 * pins the SHA-256 of `JSON.stringify(SUBMIT_TOOL)`. Any deliberate
 * change to this constant must update both this file and the pinned
 * hash in that test in the same commit.
 */
import type { DynamicToolDef } from './types.js';

export const SUBMIT_TOOL: DynamicToolDef = Object.freeze({
  name: 'harness_submit',
  description:
    "Submit data for the current FSM state. Look at the most recent orientation message in your context for the current state's name, valid exits, and required data shape.",
  readOnlyHint: true,
  inputSchema: Object.freeze({
    type: 'object',
    required: ['state', 'exit', 'data'],
    properties: {
      state: {
        type: 'string',
        description: 'Current state id; must equal the state listed in the orientation.',
      },
      exit: {
        type: 'string',
        description: 'One of the valid exits for the current state.',
      },
      data: {
        type: 'object',
        additionalProperties: true,
        description:
          'Data conforming to the (state, exit) schema; see orientation. Always a JSON object — never a JSON-encoded string.',
      },
    },
    additionalProperties: false,
  }),
});

/** Wire literal — kept as a named export so verifier and dispatcher stay byte-identical with the registration. */
export const SUBMIT_TOOL_NAME = SUBMIT_TOOL.name; // 'harness_submit'
