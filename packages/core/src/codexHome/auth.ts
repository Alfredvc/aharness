import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export type CodexAuthResolution =
  | { ok: true; authFile: string; codexHome: string; customHome: boolean }
  | { ok: false; message: string; authFile?: string; codexHome?: string; customHome: boolean };

export function resolveCodexAuthFile(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): CodexAuthResolution {
  const env = options.env ?? process.env;
  const rawCodexHome = env['CODEX_HOME'];
  const customHome = rawCodexHome !== undefined && rawCodexHome.length > 0;
  const home = customHome
    ? isAbsolute(rawCodexHome)
      ? rawCodexHome
      : resolve(options.cwd, rawCodexHome)
    : join(options.homeDir ?? homedir(), '.codex');

  let codexHome = home;
  if (customHome) {
    try {
      const st = statSync(home);
      if (!st.isDirectory()) {
        return {
          ok: false,
          customHome,
          codexHome: home,
          message: `aharness: CODEX_HOME is not a directory: ${home}\n`,
        };
      }
      codexHome = realpathSync(home);
    } catch {
      return {
        ok: false,
        customHome,
        codexHome: home,
        message: `aharness: CODEX_HOME does not exist: ${home}\n`,
      };
    }
  }

  const authFile = join(codexHome, 'auth.json');
  if (!existsSync(authFile)) {
    return {
      ok: false,
      customHome,
      codexHome,
      authFile,
      message: customHome
        ? `aharness: ${authFile} not found. Run \`CODEX_HOME=${codexHome} codex login\` first.\n`
        : `aharness: ${authFile} not found. Run \`codex login\` first.\n`,
    };
  }

  return { ok: true, customHome, codexHome, authFile };
}
