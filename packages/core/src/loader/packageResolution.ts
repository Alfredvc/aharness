import { statSync } from 'node:fs';
import * as path from 'node:path';

import { ts } from 'ts-json-schema-generator';

export interface PackageResolutionContext {
  readonly packageRoot: string;
  readonly managedProjectRoot: string;
}

const TS_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  skipDefaultLibCheck: true,
  strict: false,
  noEmit: true,
};

export function resolvePackageSourceImport(opts: {
  readonly importerFile: string;
  readonly specifier: string;
  readonly packageResolution: PackageResolutionContext;
}): string | null {
  const compilerOptions: ts.CompilerOptions = {
    ...TS_COMPILER_OPTIONS,
    baseUrl: path.join(path.resolve(opts.packageResolution.managedProjectRoot), 'node_modules'),
  };
  const resolved = ts.resolveModuleName(opts.specifier, opts.importerFile, compilerOptions, ts.sys)
    .resolvedModule?.resolvedFileName;
  if (resolved && isTypeScriptSourcePath(resolved) && isRegularFile(resolved)) {
    return path.resolve(resolved);
  }

  for (const candidate of fallbackCandidates(opts)) {
    if (isRegularFile(candidate)) return candidate;
  }
  return null;
}

function fallbackCandidates(opts: {
  readonly importerFile: string;
  readonly specifier: string;
  readonly packageResolution: PackageResolutionContext;
}): readonly string[] {
  const base = isRelativeSpecifier(opts.specifier)
    ? path.resolve(path.dirname(opts.importerFile), opts.specifier)
    : bareSpecifierBase(opts.specifier, opts.packageResolution.managedProjectRoot);
  if (base === null) return [];

  const ext = path.extname(base);
  if (ext === '.ts' || ext === '.tsx') {
    return [base];
  }

  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    const withoutExt = base.slice(0, -ext.length);
    return [`${withoutExt}.ts`, `${withoutExt}.tsx`];
  }

  if (ext.length > 0) return [];

  return [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
}

function bareSpecifierBase(specifier: string, managedProjectRoot: string): string | null {
  const parsed = parsePackageSpecifier(specifier);
  if (!parsed) return null;
  return path.join(
    path.resolve(managedProjectRoot),
    'node_modules',
    parsed.packageName,
    parsed.subpath,
  );
}

function parsePackageSpecifier(
  specifier: string,
): { readonly packageName: string; readonly subpath: string } | null {
  if (specifier.length === 0) return null;
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
    return null;
  }

  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    const scope = parts[0];
    const name = parts[1];
    if (!scope || !name) return null;
    return {
      packageName: `${scope}/${name}`,
      subpath: parts.slice(2).join('/'),
    };
  }

  const name = parts[0];
  if (!name) return null;
  return {
    packageName: name,
    subpath: parts.slice(1).join('/'),
  };
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function isTypeScriptSourcePath(filePath: string): boolean {
  return (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) && !filePath.endsWith('.d.ts');
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolveDirectFsmImport(importerFile: string, specifier: string): string {
  return path.resolve(path.dirname(importerFile), specifier.replace(/\.js$/, '.ts'));
}
