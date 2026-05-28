import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  renderPostToolUseScript,
  renderPreToolUseScript,
  renderUserPromptSubmitScript,
} from './hookScripts.js';
import type { HookKind } from '../state/hooks.js';

export interface MaterializeHookScriptsInput {
  /** Absolute target directory; will be `mkdir -p`'d. */
  readonly hookDir: string;
  /** Absolute path to the aharness runtime's hook UDS (baked into rendered scripts). */
  readonly hookSocket: string;
  /** Retained for call-site compatibility; Stop hook framing was retired in Phase 2d. */
  readonly stopHookTimeoutSec: number;
  /**
   * Hook kinds the FSM declares — write a wrapper only for these. Empty
   * array ⇒ zero per-state-hook scripts written. Codex's hook discovery
   * concatenates user `[[hooks.<Kind>]]` entries from
   * `~/.codex/config.toml` and `~/.codex/hooks.json` alongside the aharness
   * wrapper at runtime; the aharness does NOT read or parse user config.
   * See `docs/specs/2026-05-08-per-state-hooks-design.md` §5.5.
   */
  readonly declaredHookKinds: ReadonlyArray<HookKind>;
}

/**
 * Resolve the absolute path to the shipped `hookClient.cjs`.
 *
 * In TS source (vitest) this points at `src/codexHome/hookClient.cjs`. After
 * `tsc --build` + the post-build copy step, it points at
 * `dist/codexHome/hookClient.cjs`. Both are mode 0755 in their respective
 * checkouts: the source file is committed executable, and `package.json`'s
 * `build` script chmods the dist copy.
 */
export function resolveHookClientPath(): string {
  return fileURLToPath(new URL('./hookClient.cjs', import.meta.url));
}

/**
 * Per-kind wrapper-script filename. Single source of truth — Phase C's
 * `runCli.ts` imports this constant to construct the `-c hooks.<Kind>=...`
 * override path so the wrapper that codex spawns matches the wrapper
 * `materializeHookScripts` writes.
 */
export const KIND_TO_SCRIPT_NAME: Readonly<Record<HookKind, string>> = {
  PreToolUse: 'pre_tool_use.sh',
  PostToolUse: 'post_tool_use.sh',
  UserPromptSubmit: 'user_prompt_submit.sh',
};

/**
 * Write the per-run hook bash scripts under `hookDir`. Per-state hook wrappers
 * (`pre_tool_use.sh`, `post_tool_use.sh`, `user_prompt_submit.sh`) are written
 * only for kinds listed in `declaredHookKinds`.
 *
 * The corresponding `-c hooks.<Kind>=...` config-override entries are
 * injected by `runCli.ts` at `codex app-server` spawn time; this function
 * is purely filesystem-side.
 */
export function materializeHookScripts(input: MaterializeHookScriptsInput): void {
  mkdirSync(input.hookDir, { recursive: true });
  const hookClientPath = resolveHookClientPath();

  if (input.declaredHookKinds.length === 0) return;

  for (const kind of input.declaredHookKinds) {
    const scriptName = KIND_TO_SCRIPT_NAME[kind];
    const scriptPath = join(input.hookDir, scriptName);
    const renderInput = { hookSocketPath: input.hookSocket, hookClientPath };
    let body: string;
    if (kind === 'PreToolUse') body = renderPreToolUseScript(renderInput);
    else if (kind === 'PostToolUse') body = renderPostToolUseScript(renderInput);
    else body = renderUserPromptSubmitScript(renderInput);
    writeFileSync(scriptPath, body);
    chmodSync(scriptPath, 0o755);
  }
}
