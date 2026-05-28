/**
 * Render hook bash scripts that bridge Codex's hook subprocesses to the
 * aharness runtime's UDS endpoint.
 *
 * The shipped hook script is a one-liner that `exec`s a tiny Node-based UDS
 * client (`hookClient.cjs`, also shipped in this package). This avoids any
 * runtime dependency on `socat` or `nc`/`netcat` — the only thing needed is
 * the same Node interpreter that runs the aharness CLI.
 */
const HEADER = '#!/usr/bin/env bash\nset -euo pipefail\n';

export interface RenderHookKindScriptInput {
  /** Absolute path to the aharness runtime's hook UDS. */
  readonly hookSocketPath: string;
  /** Absolute path to the shipped `hookClient.cjs`. */
  readonly hookClientPath: string;
}

/**
 * pre_tool_use.sh body — forwards a PreToolUse hook payload to the aharness UDS
 * with the `PRE_TOOL_USE` framing tag.
 */
export function renderPreToolUseScript(i: RenderHookKindScriptInput): string {
  return renderKindScript('PRE_TOOL_USE', i, 'pre_tool_use.sh');
}

/**
 * post_tool_use.sh body — forwards a PostToolUse hook payload to the aharness
 * UDS with the `POST_TOOL_USE` framing tag.
 */
export function renderPostToolUseScript(i: RenderHookKindScriptInput): string {
  return renderKindScript('POST_TOOL_USE', i, 'post_tool_use.sh');
}

/**
 * user_prompt_submit.sh body — forwards a UserPromptSubmit hook payload to
 * the aharness UDS with the `USER_PROMPT_SUBMIT` framing tag.
 */
export function renderUserPromptSubmitScript(i: RenderHookKindScriptInput): string {
  return renderKindScript('USER_PROMPT_SUBMIT', i, 'user_prompt_submit.sh');
}

function renderKindScript(
  tag: 'PRE_TOOL_USE' | 'POST_TOOL_USE' | 'USER_PROMPT_SUBMIT',
  i: RenderHookKindScriptInput,
  scriptFilename: string,
): string {
  // Wrapper is a thin exec of hookClient.cjs with the kind's framing tag.
  // No aggregator, no user-config read — codex's hook discovery already
  // concatenates user [[hooks.<Kind>]] entries (from ~/.codex/config.toml,
  // ~/.codex/hooks.json, project-local, plugins) alongside this wrapper
  // and aggregates results itself. See
  // docs/specs/2026-05-08-per-state-hooks-design.md §5.5.
  return (
    HEADER +
    `# ${scriptFilename}: forward codex stdin to the aharness UDS as a ${tag} frame.\n` +
    `exec /usr/bin/env node ${shesc(i.hookClientPath)} ${shesc(tag)} ${shesc(i.hookSocketPath)}\n`
  );
}

/** POSIX single-quote shell escape — safe for any printable UTF-8 path. */
function shesc(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}
