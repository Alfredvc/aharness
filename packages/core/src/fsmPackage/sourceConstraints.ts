import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';

import { isPathInsideOrEqual, validatePackagePath } from './paths.js';
import type {
  DiscoveredFsmCommand,
  DiscoveredPackageCommand,
  FsmPackageDiagnostic,
  FsmPackageResult,
} from './types.js';

export interface CheckPackageSourceConstraintsOptions {
  readonly packageRoot: string;
  readonly fsmsDir: string;
  readonly commands: readonly DiscoveredPackageCommand[];
}

export interface PackageSourceConstraints {
  readonly checkedFiles: readonly string[];
}

interface ImportEdge {
  readonly specifier: string;
  readonly line: number;
}

const TS_COMPILER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  allowImportingTsExtensions: true,
  jsx: ts.JsxEmit.ReactJSX,
};

export async function checkPackageSourceConstraints(
  opts: CheckPackageSourceConstraintsOptions,
): Promise<FsmPackageResult<PackageSourceConstraints>> {
  const packageRoot = path.resolve(opts.packageRoot);
  const fsmsDirResult = validatePackagePath({
    packageRoot,
    relativePath: opts.fsmsDir,
    field: 'aharness.package.fsmsDir',
  });
  if (!fsmsDirResult.ok) return fsmsDirResult;

  const fsmsDirPath = fsmsDirResult.value.absolutePath;
  const diagnostics: FsmPackageDiagnostic[] = [];
  const realFsmsDirPath = await realpathFsmsDir(fsmsDirPath, diagnostics);
  if (!realFsmsDirPath) return { ok: false, diagnostics };

  const checkedFiles: string[] = [];
  const visited = new Set<string>();
  const queue = opts.commands
    .filter((command): command is DiscoveredFsmCommand => command.kind === 'fsm')
    .map((command) => path.resolve(command.filePath));

  for (let index = 0; index < queue.length; index += 1) {
    const sourceFilePath = queue[index];
    if (!sourceFilePath) continue;
    if (visited.has(sourceFilePath)) continue;
    visited.add(sourceFilePath);
    checkedFiles.push(sourceFilePath);

    const sourceIsAllowed = await validateSourceFileLocation({
      fsmsDirPath,
      realFsmsDirPath,
      sourceFilePath,
      diagnostics,
    });
    if (!sourceIsAllowed) {
      continue;
    }

    const body = await readSourceFile(sourceFilePath, diagnostics);
    if (body === null) continue;

    const source = ts.createSourceFile(
      sourceFilePath,
      body,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForPath(sourceFilePath),
    );
    const imports = collectImportEdges(source);
    for (const edge of imports) {
      if (!isRelativeSpecifier(edge.specifier)) continue;

      const resolved = await resolveTypeScriptSourceImport(sourceFilePath, edge.specifier);
      if (!resolved) continue;

      const importIsAllowed = await validateSourceFileLocation({
        fsmsDirPath,
        realFsmsDirPath,
        sourceFilePath: resolved,
        importedFrom: sourceFilePath,
        importSpecifier: edge.specifier,
        line: edge.line,
        diagnostics,
      });
      if (!importIsAllowed) {
        continue;
      }

      if (!visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  return { ok: true, value: { checkedFiles } };
}

async function realpathFsmsDir(
  fsmsDirPath: string,
  diagnostics: FsmPackageDiagnostic[],
): Promise<string | null> {
  try {
    return await fs.realpath(fsmsDirPath);
  } catch (err) {
    diagnostics.push({
      code: 'fsms-dir-realpath-failed',
      field: 'aharness.package.fsmsDir',
      path: fsmsDirPath,
      message: `could not resolve aharness.package.fsmsDir realpath: ${errorMessage(err)}`,
    });
    return null;
  }
}

async function validateSourceFileLocation(opts: {
  readonly fsmsDirPath: string;
  readonly realFsmsDirPath: string;
  readonly sourceFilePath: string;
  readonly importedFrom?: string;
  readonly importSpecifier?: string;
  readonly line?: number;
  readonly diagnostics: FsmPackageDiagnostic[];
}): Promise<boolean> {
  const sourceFilePath = path.resolve(opts.sourceFilePath);
  const sourceFile = opts.importedFrom ?? sourceFilePath;

  if (!isPathInsideOrEqual(opts.fsmsDirPath, sourceFilePath)) {
    opts.diagnostics.push({
      code: opts.importSpecifier
        ? 'source-import-outside-fsms-dir'
        : 'source-entry-outside-fsms-dir',
      sourceFile,
      ...(opts.importSpecifier ? { importSpecifier: opts.importSpecifier } : {}),
      resolvedFile: sourceFilePath,
      ...(opts.line ? { line: opts.line } : {}),
      message: opts.importSpecifier
        ? `relative TypeScript import '${opts.importSpecifier}' resolves outside aharness.package.fsmsDir`
        : 'discovered FSM source must resolve under aharness.package.fsmsDir',
    });
    return false;
  }

  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(sourceFilePath);
  } catch (err) {
    opts.diagnostics.push({
      code: 'source-stat-failed',
      sourceFile,
      ...(opts.importSpecifier ? { importSpecifier: opts.importSpecifier } : {}),
      resolvedFile: sourceFilePath,
      ...(opts.line ? { line: opts.line } : {}),
      message: `could not inspect TypeScript source: ${errorMessage(err)}`,
    });
    return false;
  }

  if (stat.isSymbolicLink()) {
    opts.diagnostics.push({
      code: 'source-symlink-rejected',
      sourceFile,
      ...(opts.importSpecifier ? { importSpecifier: opts.importSpecifier } : {}),
      resolvedFile: sourceFilePath,
      ...(opts.line ? { line: opts.line } : {}),
      message: opts.importSpecifier
        ? `relative TypeScript import '${opts.importSpecifier}' resolves to a symlink; symlinked package TypeScript sources are not supported`
        : 'symlinked package TypeScript sources are not supported',
    });
    return false;
  }

  if (!stat.isFile()) {
    opts.diagnostics.push({
      code: 'source-not-file',
      sourceFile,
      ...(opts.importSpecifier ? { importSpecifier: opts.importSpecifier } : {}),
      resolvedFile: sourceFilePath,
      ...(opts.line ? { line: opts.line } : {}),
      message: 'package TypeScript source must be a regular file',
    });
    return false;
  }

  let realSourceFilePath: string;
  try {
    realSourceFilePath = await fs.realpath(sourceFilePath);
  } catch (err) {
    opts.diagnostics.push({
      code: 'source-realpath-failed',
      sourceFile,
      ...(opts.importSpecifier ? { importSpecifier: opts.importSpecifier } : {}),
      resolvedFile: sourceFilePath,
      ...(opts.line ? { line: opts.line } : {}),
      message: `could not resolve TypeScript source realpath: ${errorMessage(err)}`,
    });
    return false;
  }

  if (!isPathInsideOrEqual(opts.realFsmsDirPath, realSourceFilePath)) {
    opts.diagnostics.push({
      code: opts.importSpecifier
        ? 'source-import-outside-fsms-dir'
        : 'source-entry-outside-fsms-dir',
      sourceFile,
      ...(opts.importSpecifier ? { importSpecifier: opts.importSpecifier } : {}),
      resolvedFile: realSourceFilePath,
      ...(opts.line ? { line: opts.line } : {}),
      message: opts.importSpecifier
        ? `relative TypeScript import '${opts.importSpecifier}' resolves outside aharness.package.fsmsDir`
        : 'discovered FSM source must resolve under aharness.package.fsmsDir',
    });
    return false;
  }

  return true;
}

function collectImportEdges(source: ts.SourceFile): ImportEdge[] {
  const imports: ImportEdge[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier)) {
      imports.push(edgeForNode(source, node.moduleSpecifier, node));
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      isStringLiteralLike(node.moduleSpecifier)
    ) {
      imports.push(edgeForNode(source, node.moduleSpecifier, node));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && isStringLiteralLike(arg)) {
        imports.push(edgeForNode(source, arg, node));
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  return imports;
}

function edgeForNode(
  source: ts.SourceFile,
  literal: ts.StringLiteralLike,
  node: ts.Node,
): ImportEdge {
  return {
    specifier: literal.text,
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
  };
}

async function resolveTypeScriptSourceImport(
  sourceFilePath: string,
  specifier: string,
): Promise<string | null> {
  const resolvedByTypeScript = ts.resolveModuleName(
    specifier,
    sourceFilePath,
    TS_COMPILER_OPTIONS,
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  if (resolvedByTypeScript && isTypeScriptSourcePath(resolvedByTypeScript)) {
    return path.resolve(resolvedByTypeScript);
  }

  for (const candidate of fallbackCandidates(sourceFilePath, specifier)) {
    if (await isRegularFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function fallbackCandidates(sourceFilePath: string, specifier: string): string[] {
  const base = path.resolve(path.dirname(sourceFilePath), specifier);
  const ext = path.extname(base);
  if (ext === '.ts' || ext === '.tsx') {
    return [base];
  }

  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    const withoutExt = base.slice(0, -ext.length);
    return [`${withoutExt}.ts`, `${withoutExt}.tsx`, `${withoutExt}.d.ts`];
  }

  if (ext.length > 0) return [];

  return [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.d.ts'),
  ];
}

async function readSourceFile(
  sourceFilePath: string,
  diagnostics: FsmPackageDiagnostic[],
): Promise<string | null> {
  try {
    return await fs.readFile(sourceFilePath, 'utf8');
  } catch (err) {
    diagnostics.push({
      code: 'source-read-failed',
      sourceFile: sourceFilePath,
      message: `could not read TypeScript source: ${errorMessage(err)}`,
    });
    return null;
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isTypeScriptSourcePath(filePath: string): boolean {
  return filePath.endsWith('.ts') || filePath.endsWith('.tsx');
}

function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  return filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function isStringLiteralLike(node: ts.Node): node is ts.StringLiteralLike {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
