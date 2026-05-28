import { rmSync } from 'node:fs';

/**
 * Recursively remove a directory tree (used by tests to clean up the tmp
 * codex_home and runDir trees they materialize). Idempotent: missing
 * paths are not an error.
 */
export function cleanupCodexHome(codexHome: string): void {
  rmSync(codexHome, { recursive: true, force: true });
}
