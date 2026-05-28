import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { validatePackageWriteTarget } from './paths.js';
import type { FsmPackageDiagnostic } from './types.js';
import { verifyFsmPackage } from './verify.js';

export interface BuildFsmPackageOptions {
  readonly packageRoot: string;
  readonly log?: (line: string) => void;
}

export type BuildFsmPackageResult =
  | {
      readonly ok: true;
      readonly exitCode: 0;
      readonly value: {
        readonly binPath: string;
      };
    }
  | {
      readonly ok: false;
      readonly exitCode: 1 | 2;
      readonly diagnostics: readonly FsmPackageDiagnostic[];
    };

export async function buildFsmPackage(
  opts: BuildFsmPackageOptions,
): Promise<BuildFsmPackageResult> {
  const verified = await verifyFsmPackage(opts);
  if (!verified.ok) {
    return verified;
  }

  const config = verified.value.config;
  const writeTarget = await validatePackageWriteTarget({
    packageRoot: config.packageRoot,
    relativePath: config.binRelativePath,
    field: `bin.${config.binName}`,
  });
  if (!writeTarget.ok) {
    return { ok: false, exitCode: 2, diagnostics: writeTarget.diagnostics };
  }

  const binPath = writeTarget.value.absolutePath;
  const binDir = path.dirname(binPath);
  const tempPath = path.join(
    binDir,
    `.${path.basename(binPath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(tempPath, verified.value.renderedBin, { mode: 0o755 });
    if (process.platform !== 'win32') {
      await fs.chmod(tempPath, 0o755);
    }
    await fs.rename(tempPath, binPath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    return {
      ok: false,
      exitCode: 2,
      diagnostics: [
        {
          code: 'bin-write-failed',
          field: `bin.${config.binName}`,
          path: config.binRelativePath,
          message: `could not write generated bin atomically: ${errorMessage(err)}`,
        },
      ],
    };
  }

  return {
    ok: true,
    exitCode: 0,
    value: {
      binPath,
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
