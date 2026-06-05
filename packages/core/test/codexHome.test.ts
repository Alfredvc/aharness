import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  renderPostToolUseScript,
  renderPreToolUseScript,
  renderUserPromptSubmitScript,
} from '../src/codexHome/hookScripts.js';
import { cleanupCodexHome } from '../src/codexHome/cleanup.js';
import { materializeHookScripts, resolveHookClientPath } from '../src/codexHome/materialize.js';
import { resolveCodexAuthFile } from '../src/codexHome/auth.js';

describe('renderPreToolUseScript', () => {
  it('execs hookClient with the PRE_TOOL_USE tag', () => {
    const sh = renderPreToolUseScript({
      hookSocketPath: '/run/hook.sock',
      hookClientPath: '/abs/path/hookClient.cjs',
    });
    expect(sh).toContain('exec /usr/bin/env node');
    expect(sh).toContain("'/abs/path/hookClient.cjs' 'PRE_TOOL_USE' '/run/hook.sock'");
  });
});

describe('renderPostToolUseScript', () => {
  it('execs hookClient with the POST_TOOL_USE tag', () => {
    const sh = renderPostToolUseScript({
      hookSocketPath: '/run/hook.sock',
      hookClientPath: '/abs/path/hookClient.cjs',
    });
    expect(sh).toContain("'/abs/path/hookClient.cjs' 'POST_TOOL_USE' '/run/hook.sock'");
  });
});

describe('renderUserPromptSubmitScript', () => {
  it('execs hookClient with the USER_PROMPT_SUBMIT tag', () => {
    const sh = renderUserPromptSubmitScript({
      hookSocketPath: '/run/hook.sock',
      hookClientPath: '/abs/path/hookClient.cjs',
    });
    expect(sh).toContain("'/abs/path/hookClient.cjs' 'USER_PROMPT_SUBMIT' '/run/hook.sock'");
  });
});

describe('resolveHookClientPath', () => {
  it('resolves to a file that exists with executable bits set', () => {
    const p = resolveHookClientPath();
    expect(p.endsWith('hookClient.cjs')).toBe(true);
    const st = statSync(p);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o111).toBeGreaterThan(0);
  });
});

describe('materializeHookScripts', () => {
  it('writes no scripts when no per-state hook kinds are declared', () => {
    const root = mkdtempSync(join(tmpdir(), 'h-cdx-'));
    try {
      const hookDir = join(root, 'hooks');
      const hookSocket = join(root, 'hook.sock');
      materializeHookScripts({
        hookDir,
        hookSocket,
        stopHookTimeoutSec: 30,
        declaredHookKinds: [],
      });

      // No config.toml is written (overrides are passed via -c by runCli).
      expect(existsSync(join(root, 'config.toml'))).toBe(false);
      expect(existsSync(join(hookDir, 'config.toml'))).toBe(false);
      expect(existsSync(join(hookDir, 'stop.sh'))).toBe(false);
      expect(existsSync(join(hookDir, 'pre_tool_use.sh'))).toBe(false);
      expect(existsSync(join(hookDir, 'post_tool_use.sh'))).toBe(false);
      expect(existsSync(join(hookDir, 'user_prompt_submit.sh'))).toBe(false);
    } finally {
      cleanupCodexHome(root);
    }
  });
});

describe('materializeHookScripts — per-state hooks', () => {
  it('writes pre_tool_use.sh when PreToolUse is declared', () => {
    const root = mkdtempSync(join(tmpdir(), 'h-cdx-'));
    try {
      const hookDir = join(root, 'hooks');
      const hookSocket = join(root, 'hook.sock');
      materializeHookScripts({
        hookDir,
        hookSocket,
        stopHookTimeoutSec: 30,
        declaredHookKinds: ['PreToolUse'],
      });
      const sh = readFileSync(join(hookDir, 'pre_tool_use.sh'), 'utf8');
      // Byte-equal with the renderer — guards against materialize.ts
      // drifting from hookScripts.ts (e.g. wrong tag, inlined body).
      expect(sh).toBe(
        renderPreToolUseScript({
          hookSocketPath: hookSocket,
          hookClientPath: resolveHookClientPath(),
        }),
      );
      const st = statSync(join(hookDir, 'pre_tool_use.sh'));
      expect((st.mode & 0o777).toString(8)).toBe('755');
      // Other kinds NOT declared — no wrapper for them.
      expect(existsSync(join(hookDir, 'post_tool_use.sh'))).toBe(false);
      expect(existsSync(join(hookDir, 'user_prompt_submit.sh'))).toBe(false);
      expect(existsSync(join(hookDir, 'stop.sh'))).toBe(false);
    } finally {
      cleanupCodexHome(root);
    }
  });

  it('writes all three per-kind wrappers when all kinds are declared', () => {
    const root = mkdtempSync(join(tmpdir(), 'h-cdx-'));
    try {
      const hookDir = join(root, 'hooks');
      materializeHookScripts({
        hookDir,
        hookSocket: join(root, 'hook.sock'),
        stopHookTimeoutSec: 30,
        declaredHookKinds: ['PreToolUse', 'PostToolUse', 'UserPromptSubmit'],
      });
      expect(existsSync(join(hookDir, 'pre_tool_use.sh'))).toBe(true);
      expect(existsSync(join(hookDir, 'post_tool_use.sh'))).toBe(true);
      expect(existsSync(join(hookDir, 'user_prompt_submit.sh'))).toBe(true);
    } finally {
      cleanupCodexHome(root);
    }
  });
});

describe('cleanupCodexHome', () => {
  it('removes the directory tree and is idempotent on missing paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'h-cdx-'));
    const hookDir = join(root, 'hooks');
    materializeHookScripts({
      hookDir,
      hookSocket: join(root, 'hook.sock'),
      stopHookTimeoutSec: 5,
      declaredHookKinds: [],
    });
    expect(existsSync(hookDir)).toBe(true);
    cleanupCodexHome(root);
    expect(existsSync(root)).toBe(false);
    // Idempotent — second call must not throw.
    expect(() => cleanupCodexHome(root)).not.toThrow();
  });
});

describe('resolveCodexAuthFile', () => {
  it('checks ~/.codex/auth.json when CODEX_HOME is unset', () => {
    const home = mkdtempSync(join(tmpdir(), 'h-cdx-home-'));
    try {
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'auth.json'), '{}');

      expect(resolveCodexAuthFile({ cwd: home, homeDir: home, env: {} })).toEqual({
        ok: true,
        customHome: false,
        codexHome: join(home, '.codex'),
        authFile: join(home, '.codex', 'auth.json'),
      });
    } finally {
      cleanupCodexHome(home);
    }
  });

  it('resolves relative CODEX_HOME against cwd and canonicalizes it', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'h-cdx-cwd-'));
    try {
      mkdirSync(join(cwd, 'codex-home'));
      writeFileSync(join(cwd, 'codex-home', 'auth.json'), '{}');

      const resolved = resolveCodexAuthFile({
        cwd,
        homeDir: '/unused',
        env: { CODEX_HOME: 'codex-home' },
      });
      const canonicalHome = realpathSync(join(cwd, 'codex-home'));

      expect(resolved).toMatchObject({
        ok: true,
        customHome: true,
        codexHome: canonicalHome,
        authFile: join(canonicalHome, 'auth.json'),
      });
    } finally {
      cleanupCodexHome(cwd);
    }
  });

  it('reports invalid custom CODEX_HOME before checking auth.json', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'h-cdx-cwd-'));
    try {
      const resolved = resolveCodexAuthFile({
        cwd,
        env: { CODEX_HOME: 'missing-home' },
      });

      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.message).toContain('CODEX_HOME does not exist');
        expect(resolved.message).toContain(join(cwd, 'missing-home'));
      }
    } finally {
      cleanupCodexHome(cwd);
    }
  });

  it('names the checked custom auth path and login command', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'h-cdx-cwd-'));
    try {
      mkdirSync(join(cwd, 'codex-home'));
      const resolved = resolveCodexAuthFile({
        cwd,
        env: { CODEX_HOME: 'codex-home' },
      });

      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        const canonicalHome = realpathSync(join(cwd, 'codex-home'));
        expect(resolved.message).toContain(join(canonicalHome, 'auth.json'));
        expect(resolved.message).toContain(`CODEX_HOME=${canonicalHome} codex login`);
      }
    } finally {
      cleanupCodexHome(cwd);
    }
  });
});
