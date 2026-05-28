import type { HookKind } from '../state/hooks.js';

import { escapeTomlBasicString } from './tomlEscape.js';

const HOOK_TIMEOUT_SEC = 30;

export function renderHookCliOverride(
  kind: HookKind,
  scriptPath: string,
): readonly [string, string] {
  return [
    `hooks.${kind}`,
    `[{ hooks = [{ type = "command", command = ${escapeTomlBasicString(shellQuote(scriptPath))}, timeout = ${HOOK_TIMEOUT_SEC}, statusMessage = ${escapeTomlBasicString(`harness ${kind}`)} }] }]`,
  ];
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
