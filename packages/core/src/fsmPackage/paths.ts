import type { FsmPackageResult, PackagePath } from './types.js';
import {
  isPathInsideOrEqual,
  normalizePackageRelativePath,
  validatePackagePath as validateInternalPackagePath,
  validatePackageWriteTarget as validateInternalPackageWriteTarget,
  type ValidatePackagePathOptions,
  type ValidatePackageWriteTargetOptions,
} from '../internal/packagePaths.js';

export function validatePackagePath(
  opts: ValidatePackagePathOptions,
): FsmPackageResult<PackagePath> {
  return validateInternalPackagePath(opts) as FsmPackageResult<PackagePath>;
}

export async function validatePackageWriteTarget(
  opts: ValidatePackageWriteTargetOptions,
): Promise<FsmPackageResult<PackagePath>> {
  return (await validateInternalPackageWriteTarget(opts)) as FsmPackageResult<PackagePath>;
}

export { isPathInsideOrEqual, normalizePackageRelativePath };
export type { ValidatePackagePathOptions, ValidatePackageWriteTargetOptions };
