/**
 * Phase 2d hook walk fixture.
 *
 * Topology:
 *
 *   hooked (declares PreToolUse, PostToolUse, UserPromptSubmit)
 *     ──next→ quiet (declares no hooks) ──finish→ done
 *
 * The hook handlers return deterministic JSON so integration tests can
 * prove framed UDS requests route to the active state's per-kind handlers,
 * then return `{}` after the FSM leaves the hook-declaring state.
 */
import { exit, harness, state, terminal, type HarnessMachine } from '@aharness/core';

interface EmptyPayload {
  readonly _empty?: never;
}

export const hookWalkMachine: HarnessMachine<
  unknown,
  unknown,
  Record<string, unknown>
> = harness.machine({
  id: 'hook-walk',
  initial: 'hooked',
  states: {
    hooked: state({
      entryPrompt: 'state with all supported hooks',
      exits: {
        next: exit<EmptyPayload>({ to: 'quiet' }),
      },
      hooks: {
        preToolUse: [
          {
            matcher: '.*',
            handler: () => ({
              hookSpecificOutput: {
                permissionDecision: 'deny' as const,
                permissionDecisionReason: 'pre from hooked',
              },
            }),
          },
        ],
        postToolUse: [
          {
            matcher: '.*',
            handler: () => ({
              hookSpecificOutput: { additionalContext: 'post from hooked' },
            }),
          },
        ],
        userPromptSubmit: [
          {
            handler: () => ({
              hookSpecificOutput: { additionalContext: 'prompt from hooked' },
            }),
          },
        ],
      },
    }),
    quiet: state({
      entryPrompt: 'state with no hooks',
      exits: {
        finish: exit<EmptyPayload>({ to: 'done' }),
      },
    }),
    done: terminal('success'),
  },
});

export const HOOK_WALK_FSM_SOURCE = `import { exit, harness, state, terminal } from '@aharness/core';

interface EmptyPayload {
  _empty?: never;
}

export default harness.machine({
  id: 'hook-walk',
  initial: 'hooked',
  states: {
    hooked: state({
      entryPrompt: 'state with all supported hooks',
      exits: {
        next: exit<EmptyPayload>({ to: 'quiet' }),
      },
      hooks: {
        preToolUse: [
          {
            matcher: '.*',
            handler: () => ({
              hookSpecificOutput: {
                permissionDecision: 'deny' as const,
                permissionDecisionReason: 'pre from hooked',
              },
            }),
          },
        ],
        postToolUse: [
          {
            matcher: '.*',
            handler: () => ({
              hookSpecificOutput: { additionalContext: 'post from hooked' },
            }),
          },
        ],
        userPromptSubmit: [
          {
            handler: () => ({
              hookSpecificOutput: { additionalContext: 'prompt from hooked' },
            }),
          },
        ],
      },
    }),
    quiet: state({
      entryPrompt: 'state with no hooks',
      exits: {
        finish: exit<EmptyPayload>({ to: 'done' }),
      },
    }),
    done: terminal('success'),
  },
});
`;
