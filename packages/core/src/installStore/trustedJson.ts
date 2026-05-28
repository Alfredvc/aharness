import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { canonicalJson } from '../internal/canonicalJson.js';
import type { InstallStoreResult } from './types.js';

export type TrustedJsonValidator<T> = (value: unknown, filePath?: string) => InstallStoreResult<T>;

export async function readTrustedJson<T>(
  filePath: string,
  validate: TrustedJsonValidator<T>,
): Promise<InstallStoreResult<T>> {
  let body: string;
  try {
    body = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'trusted-json-read-failed',
          path: filePath,
          message: `could not read trusted JSON file: ${errorMessage(err)}`,
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'trusted-json-invalid',
          path: filePath,
          message: `trusted JSON file is not valid JSON: ${errorMessage(err)}`,
        },
      ],
    };
  }

  return validate(parsed, filePath);
}

export async function writeTrustedJson(
  filePath: string,
  value: unknown,
): Promise<InstallStoreResult<{ readonly path: string }>> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle: fs.FileHandle | undefined;

  try {
    await fs.mkdir(dir, { recursive: true });
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
    await fsyncDirectoryBestEffort(dir);
    return { ok: true, value: { path: filePath } };
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original write diagnostic.
      }
    }
    await removeTempBestEffort(tempPath);
    return {
      ok: false,
      diagnostics: [
        {
          code: 'trusted-json-write-failed',
          path: filePath,
          message: `could not write trusted JSON file atomically: ${errorMessage(err)}`,
        },
      ],
    };
  }
}

async function fsyncDirectoryBestEffort(dir: string): Promise<void> {
  let dirHandle: fs.FileHandle | undefined;
  try {
    dirHandle = await fs.open(dir, 'r');
    await dirHandle.sync();
  } catch {
    // Some platforms/filesystems reject directory fsync; the file write and
    // rename already succeeded, so this remains a durability best effort.
  } finally {
    if (dirHandle) {
      try {
        await dirHandle.close();
      } catch {
        // Best effort only.
      }
    }
  }
}

async function removeTempBestEffort(tempPath: string): Promise<void> {
  try {
    await fs.rm(tempPath, { force: true });
  } catch {
    // Preserve the original write diagnostic.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
