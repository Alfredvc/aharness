import { describe, expect, it } from 'vitest';

import { escapeTomlBasicString } from './tomlEscape.js';
import { renderHookCliOverride, shellQuote } from './hookOverrides.js';

describe('escapeTomlBasicString', () => {
  it('quotes a plain alphanumeric path', () => {
    expect(escapeTomlBasicString('foo')).toBe('"foo"');
  });

  it('preserves spaces inside the quoted string', () => {
    expect(escapeTomlBasicString('with space')).toBe('"with space"');
  });

  it('escapes embedded double quotes', () => {
    expect(escapeTomlBasicString('with"quote')).toBe('"with\\"quote"');
  });

  it('escapes embedded backslashes', () => {
    expect(escapeTomlBasicString('back\\slash')).toBe('"back\\\\slash"');
  });

  it('escapes named control chars: tab', () => {
    expect(escapeTomlBasicString('tab\there')).toBe('"tab\\there"');
  });

  it('escapes named control chars: newline', () => {
    expect(escapeTomlBasicString('newline\n')).toBe('"newline\\n"');
  });

  it('escapes other named control chars: \\b \\f \\r', () => {
    expect(escapeTomlBasicString('\b')).toBe('"\\b"');
    expect(escapeTomlBasicString('\f')).toBe('"\\f"');
    expect(escapeTomlBasicString('\r')).toBe('"\\r"');
  });

  it('escapes unnamed control chars via \\uXXXX', () => {
    // U+0001 (no named escape) — must round-trip via .
    expect(escapeTomlBasicString('')).toBe('"\\u0001"');
    // U+007F DEL — also no named escape, must use .
    expect(escapeTomlBasicString('')).toBe('"\\u007f"');
  });

  it('handles a typical absolute path', () => {
    expect(escapeTomlBasicString('/runs/X/hooks/stop.sh')).toBe('"/runs/X/hooks/stop.sh"');
  });
});

describe('renderHookCliOverride', () => {
  it('renders a matcher-group inline array for a hook command', () => {
    expect(renderHookCliOverride('PreToolUse', '/runs/X/hooks/pre_tool_use.sh')).toEqual([
      'hooks.PreToolUse',
      '[{ hooks = [{ type = "command", command = "\'/runs/X/hooks/pre_tool_use.sh\'", timeout = 30, statusMessage = "harness PreToolUse" }] }]',
    ]);
  });

  it('shell-quotes single quotes and TOML-escapes control characters', () => {
    const scriptPath = "/tmp/run's/hooks/with space\npre.sh";
    const [, value] = renderHookCliOverride('UserPromptSubmit', scriptPath);

    expect(shellQuote(scriptPath)).toBe("'/tmp/run'\\''s/hooks/with space\npre.sh'");
    expect(value).toContain("command = \"'/tmp/run'\\\\''s/hooks/with space\\npre.sh'\"");
    expect(value).not.toContain('matcher');
    expect(value).toContain('statusMessage = "harness UserPromptSubmit"');
  });
});
