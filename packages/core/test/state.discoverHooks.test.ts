import { describe, expect, it } from 'vitest';

import { aharness } from '../src/state/machine.js';
import { exit, state, terminal } from '../src/state/exits.js';
import { createFsm } from '../src/state/createFsm.js';
import { discoverDeclaredHookKinds } from '../src/state/discoverHooks.js';

describe('discoverDeclaredHookKinds', () => {
  it('returns an empty array when no state declares hooks', () => {
    const m = aharness.machine({
      id: 'm',
      initial: 's',
      states: {
        s: state({
          entryPrompt: 'p',
          exits: { go: exit<{ x: number }>({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    expect(discoverDeclaredHookKinds(m)).toEqual([]);
  });

  it('returns a deduplicated set of declared kinds in codex declaration order', () => {
    const m = aharness.machine({
      id: 'm',
      initial: 's',
      states: {
        s: state({
          entryPrompt: 'p',
          exits: { go: exit<{ x: number }>({ to: 's2' }) },
          hooks: {
            preToolUse: [{ matcher: '^Bash$', handler: () => undefined }],
            userPromptSubmit: [{ handler: () => undefined }],
          },
        }),
        s2: state({
          entryPrompt: 'p',
          exits: { go: exit<{ x: number }>({ to: 'done' }) },
          hooks: {
            preToolUse: [{ matcher: '^Edit$', handler: () => undefined }],
            postToolUse: [{ matcher: '^Edit$', handler: () => undefined }],
          },
        }),
        done: terminal('success'),
      },
    });
    // Order matches codex's `HOOK_EVENT_NAMES` declaration in
    // `codex-rs/hooks/src/lib.rs` so a future audit reading the codex source
    // and the aharness output side-by-side does not need to mentally re-sort.
    expect(discoverDeclaredHookKinds(m)).toEqual(['PreToolUse', 'PostToolUse', 'UserPromptSubmit']);
  });

  it('ignores empty arrays', () => {
    const m = aharness.machine({
      id: 'm',
      initial: 's',
      states: {
        s: state({
          entryPrompt: 'p',
          exits: { go: exit<{ x: number }>({ to: 'done' }) },
          hooks: { preToolUse: [], postToolUse: undefined },
        }),
        done: terminal('success'),
      },
    });
    expect(discoverDeclaredHookKinds(m)).toEqual([]);
  });

  it('ignores permissionRequest because it is not a codex hook-engine kind', () => {
    const m = aharness.machine({
      id: 'm',
      initial: 's',
      states: {
        s: state({
          entryPrompt: 'p',
          exits: { go: exit<{ x: number }>({ to: 'done' }) },
          hooks: {
            permissionRequest: [{ matcher: '^Bash$', handler: () => 'delegate' }],
          },
        }),
        done: terminal('success'),
      },
    });
    expect(discoverDeclaredHookKinds(m)).toEqual([]);
  });

  it('does not let permissionRequest affect codex hook-engine ordering', () => {
    const m = aharness.machine({
      id: 'm',
      initial: 's',
      states: {
        s: state({
          entryPrompt: 'p',
          exits: { go: exit<{ x: number }>({ to: 'done' }) },
          hooks: {
            permissionRequest: [{ matcher: '^Bash$', handler: () => 'delegate' }],
            postToolUse: [{ matcher: '^Edit$', handler: () => undefined }],
            preToolUse: [{ matcher: '^Bash$', handler: () => undefined }],
          },
        }),
        done: terminal('success'),
      },
    });
    expect(discoverDeclaredHookKinds(m)).toEqual(['PreToolUse', 'PostToolUse']);
  });

  it('discovers canonical built-in hook events that need codex hook wrappers', () => {
    const fsm = createFsm<{ count: number }>();
    const m = fsm.machine({
      id: 'm',
      initial: 's',
      data: { count: 0 },
      states: {
        s: fsm.state({
          prompt: 'p',
          on: {
            postToolUse: { return: () => undefined },
            userPromptSubmit: { return: () => undefined },
            permissionRequest: { return: () => 'delegate' },
          },
        }),
      },
    });

    expect(discoverDeclaredHookKinds(m)).toEqual(['PostToolUse', 'UserPromptSubmit']);
  });
});
