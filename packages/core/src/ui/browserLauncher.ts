import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';

export interface BrowserLaunchSuccess {
  readonly ok: true;
}

export interface BrowserLaunchFailure {
  readonly ok: false;
  readonly reason: 'invalid-url' | 'spawn-failed';
  readonly message: string;
}

export type BrowserLaunchResult = BrowserLaunchSuccess | BrowserLaunchFailure;

export type BrowserLauncherSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly detached: true; readonly stdio: 'ignore' },
) => ChildProcess;

export interface LaunchBrowserOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: BrowserLauncherSpawn;
}

export function launchBrowser(
  url: string,
  options: LaunchBrowserOptions = {},
): BrowserLaunchResult {
  const parsed = parseBrowserUrl(url);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: 'invalid-url',
      message: `unsupported browser URL: ${url}`,
    };
  }

  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? nodeSpawn;
  const command = openerCommand(platform, parsed.url.href);

  try {
    const child = spawn(command.command, command.args, {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', () => {
      /* Best-effort opener failure after spawn must not crash the CLI. */
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: 'spawn-failed',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

function parseBrowserUrl(
  url: string,
): { readonly ok: true; readonly url: URL } | { readonly ok: false } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false };
    }
    return { ok: true, url: parsed };
  } catch {
    return { ok: false };
  }
}

function openerCommand(
  platform: NodeJS.Platform,
  url: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', url] };
  }
  return { command: 'xdg-open', args: [url] };
}
