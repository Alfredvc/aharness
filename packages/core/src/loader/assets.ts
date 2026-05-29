import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

import { isPathInsideOrEqual, validatePackagePath } from '../internal/packagePaths.js';

export type InstalledAssetCallKind = 'getAssetUrl' | 'getAssetText';

export interface InstalledAssetRecord {
  readonly sourceFile: string;
  readonly kind: InstalledAssetCallKind;
  readonly packageRoot: string;
  readonly relativePath: string;
  readonly resolvedFile: string;
  readonly fileUrl: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface InstalledAssetDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly sourceFile: string;
  readonly line: number;
  readonly column: number;
  readonly length: number;
  readonly lineText: string;
}

export interface TransformInstalledAssetCallsResult {
  readonly contents: string;
  readonly assets: readonly InstalledAssetRecord[];
  readonly diagnostics: readonly InstalledAssetDiagnostic[];
  readonly changed: boolean;
}

interface AssetCandidate {
  readonly kind: InstalledAssetCallKind;
  readonly arg: ts.Expression | undefined;
  readonly call: ts.CallExpression;
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const AHARNESS_CORE_SPECIFIER = '@aharness/core';
const SOURCE_FILE_RE = /\.[cm]?[jt]sx?$/;

export async function transformInstalledAssetCalls(opts: {
  readonly sourceFile: string;
  readonly sourceText: string;
  readonly managedProjectRoot: string;
}): Promise<TransformInstalledAssetCallsResult> {
  const sourceFile = path.resolve(opts.sourceFile);
  if (!SOURCE_FILE_RE.test(sourceFile)) {
    return emptyTransform(opts.sourceText);
  }

  const packageRoot = await findContainingPackageRoot({
    sourceFile,
    managedProjectRoot: opts.managedProjectRoot,
  });
  if (packageRoot === null) {
    return emptyTransform(opts.sourceText);
  }

  const source = ts.createSourceFile(
    sourceFile,
    opts.sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(sourceFile),
  );
  const aharnessBindings = collectAharnessBindings(source);
  if (aharnessBindings.size === 0) {
    return emptyTransform(opts.sourceText);
  }

  const candidates = collectAssetCandidates(source, aharnessBindings);
  if (candidates.length === 0) {
    return emptyTransform(opts.sourceText);
  }

  const realPackageRoot = await fs.realpath(packageRoot);
  const diagnostics: InstalledAssetDiagnostic[] = [];
  const assets: InstalledAssetRecord[] = [];
  const replacements: Replacement[] = [];

  for (const candidate of candidates) {
    const arg = candidate.arg;
    const diagnosticNode = arg ?? candidate.call;
    if (!arg || !ts.isStringLiteral(arg)) {
      diagnostics.push(
        diagnosticForNode({
          source,
          node: diagnosticNode,
          code: 'asset-path-dynamic',
          message:
            `${candidate.kind} asset calls in installable packages must use ` +
            'a string literal first argument',
        }),
      );
      continue;
    }

    const validated = await validateAssetCandidate({
      source,
      arg,
      kind: candidate.kind,
      packageRoot,
      realPackageRoot,
    });
    if (validated.ok) {
      assets.push(validated.asset);
      replacements.push({
        start: validated.asset.start,
        end: validated.asset.end,
        text: JSON.stringify(validated.asset.fileUrl),
      });
    } else {
      diagnostics.push(validated.diagnostic);
    }
  }

  if (diagnostics.length > 0) {
    return {
      contents: opts.sourceText,
      assets: [],
      diagnostics,
      changed: false,
    };
  }

  const contents = applyReplacements(opts.sourceText, replacements);
  return {
    contents,
    assets,
    diagnostics: [],
    changed: replacements.length > 0,
  };
}

export async function findContainingPackageRoot(opts: {
  readonly sourceFile: string;
  readonly managedProjectRoot: string;
}): Promise<string | null> {
  const nodeModulesRoot = path.join(path.resolve(opts.managedProjectRoot), 'node_modules');
  let current = path.dirname(path.resolve(opts.sourceFile));

  while (isPathInsideOrEqual(nodeModulesRoot, current)) {
    const packageJsonPath = path.join(current, 'package.json');
    try {
      const stat = await fs.stat(packageJsonPath);
      if (stat.isFile()) return current;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function emptyTransform(sourceText: string): TransformInstalledAssetCallsResult {
  return {
    contents: sourceText,
    assets: [],
    diagnostics: [],
    changed: false,
  };
}

function collectAharnessBindings(source: ts.SourceFile): Set<string> {
  const bindings = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== AHARNESS_CORE_SPECIFIER) continue;

    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const namedBindings = clause.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;

    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName === 'aharness') {
        bindings.add(element.name.text);
      }
    }
  }
  return bindings;
}

function collectAssetCandidates(
  source: ts.SourceFile,
  aharnessBindings: ReadonlySet<string>,
): AssetCandidate[] {
  const candidates: AssetCandidate[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const kind = assetCallKind(node.expression, aharnessBindings);
      if (kind) {
        candidates.push({
          kind,
          arg: node.arguments[0],
          call: node,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return candidates;
}

function assetCallKind(
  expression: ts.Expression,
  aharnessBindings: ReadonlySet<string>,
): InstalledAssetCallKind | null {
  if (!ts.isPropertyAccessExpression(expression)) return null;
  if (!ts.isIdentifier(expression.expression)) return null;
  if (!aharnessBindings.has(expression.expression.text)) return null;

  const method = expression.name.text;
  if (method === 'getAssetUrl' || method === 'getAssetText') return method;
  return null;
}

async function validateAssetCandidate(opts: {
  readonly source: ts.SourceFile;
  readonly arg: ts.StringLiteral;
  readonly kind: InstalledAssetCallKind;
  readonly packageRoot: string;
  readonly realPackageRoot: string;
}): Promise<
  | { readonly ok: true; readonly asset: InstalledAssetRecord }
  | { readonly ok: false; readonly diagnostic: InstalledAssetDiagnostic }
> {
  const pathResult = validatePackagePath({
    packageRoot: opts.packageRoot,
    relativePath: opts.arg.text,
    field: 'asset path',
  });
  if (!pathResult.ok) {
    const first = pathResult.diagnostics[0];
    return {
      ok: false,
      diagnostic: diagnosticForNode({
        source: opts.source,
        node: opts.arg,
        code: first?.code ?? 'asset-path-invalid',
        message: first?.message ?? 'asset path is invalid',
      }),
    };
  }

  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(pathResult.value.absolutePath);
  } catch (err) {
    return {
      ok: false,
      diagnostic: diagnosticForNode({
        source: opts.source,
        node: opts.arg,
        code: 'asset-stat-failed',
        message: `asset path does not exist or could not be inspected: ${errorMessage(err)}`,
      }),
    };
  }

  if (stat.isSymbolicLink()) {
    return {
      ok: false,
      diagnostic: diagnosticForNode({
        source: opts.source,
        node: opts.arg,
        code: 'asset-symlink-rejected',
        message: 'asset paths must not be symlinks',
      }),
    };
  }

  if (!stat.isFile()) {
    return {
      ok: false,
      diagnostic: diagnosticForNode({
        source: opts.source,
        node: opts.arg,
        code: 'asset-not-file',
        message: 'asset path must resolve to a regular file',
      }),
    };
  }

  let realAssetPath: string;
  try {
    realAssetPath = await fs.realpath(pathResult.value.absolutePath);
  } catch (err) {
    return {
      ok: false,
      diagnostic: diagnosticForNode({
        source: opts.source,
        node: opts.arg,
        code: 'asset-realpath-failed',
        message: `could not resolve asset path realpath: ${errorMessage(err)}`,
      }),
    };
  }

  if (!isPathInsideOrEqual(opts.realPackageRoot, realAssetPath)) {
    return {
      ok: false,
      diagnostic: diagnosticForNode({
        source: opts.source,
        node: opts.arg,
        code: 'asset-realpath-escapes',
        message: 'asset path realpath escapes package root',
      }),
    };
  }

  return {
    ok: true,
    asset: {
      sourceFile: opts.source.fileName,
      kind: opts.kind,
      packageRoot: opts.packageRoot,
      relativePath: pathResult.value.relativePath,
      resolvedFile: pathResult.value.absolutePath,
      fileUrl: pathToFileURL(pathResult.value.absolutePath).href,
      start: opts.arg.getStart(opts.source),
      end: opts.arg.getEnd(),
      line: lineAndTextForPosition(opts.source, opts.arg.getStart(opts.source)).line,
      column: lineAndTextForPosition(opts.source, opts.arg.getStart(opts.source)).column,
    },
  };
}

function diagnosticForNode(opts: {
  readonly source: ts.SourceFile;
  readonly node: ts.Node;
  readonly code: string;
  readonly message: string;
}): InstalledAssetDiagnostic {
  const start = opts.node.getStart(opts.source);
  const location = lineAndTextForPosition(opts.source, start);
  return {
    code: opts.code,
    message: `${opts.source.fileName}:${location.line}:${location.column + 1}: ${opts.message}`,
    sourceFile: opts.source.fileName,
    line: location.line,
    column: location.column,
    length: Math.max(1, opts.node.getEnd() - start),
    lineText: location.lineText,
  };
}

function lineAndTextForPosition(
  source: ts.SourceFile,
  position: number,
): { readonly line: number; readonly column: number; readonly lineText: string } {
  const { line, character } = source.getLineAndCharacterOfPosition(position);
  const lineStarts = source.getLineStarts();
  const lineStart = lineStarts[line] ?? 0;
  const nextLineStart = lineStarts[line + 1] ?? source.text.length;
  return {
    line: line + 1,
    column: character,
    lineText: source.text.slice(lineStart, nextLineStart).replace(/\r?\n$/, ''),
  };
}

function applyReplacements(sourceText: string, replacements: readonly Replacement[]): string {
  let out = sourceText;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, replacement.start) + replacement.text + out.slice(replacement.end);
  }
  return out;
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
