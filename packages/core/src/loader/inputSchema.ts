/**
 * Walk the `input: { field: arg<T>(...) }` literal of a `aharness.machine(...)`
 * call and emit a JSON Schema 7 fragment per field plus per-field `ArgFlagMeta`.
 *
 * Empty `input: {}` is distinguishable from absent input: the walker emits
 * `{type: 'object', properties: {}, required: [], additionalProperties: false}`
 * and an empty `flags` map. Callers that need to detect "no input declaration"
 * read the absence of an `input:` property at the call site (handled by the
 * caller in `sidecar.ts`).
 */

import { ts, type SchemaGenerator } from 'ts-json-schema-generator';
import type { JSONSchema7 } from 'json-schema';
import type { SidecarIssue } from './sidecar.js';
import { staticPropertyName, extractTypeArgFromTypeCall } from './sidecar.js';

/**
 * Static representation of `arg.meta.completion`. The runtime form
 * `{dynamic: <fn>}` is reduced to `{dynamic: true}` at AST time — the
 * function reference is not JSON-serialisable, and the loader cache only
 * persists static metadata. Phase 4's `aharness __complete` re-imports the
 * FSM source to obtain the live callback when the user presses Tab on a
 * dynamic flag value.
 */
export type StaticCompletionKind =
  | 'file'
  | 'directory'
  | { readonly values: ReadonlyArray<string> }
  | { readonly dynamic: true };

export interface ArgFlagMeta {
  readonly description?: string;
  readonly default?: unknown;
  readonly completion?: StaticCompletionKind;
}

export interface InputExtraction {
  readonly schema: JSONSchema7;
  readonly flags: Record<string, ArgFlagMeta>;
}

/**
 * Identifier names bound to the `arg` export of `@aharness/core`.
 *
 * `directNames` collects identifiers from `import { arg } from '@aharness/core'`
 * (with optional rename via `import { arg as a }`). `namespaceNames` collects
 * names from `import * as ns from '@aharness/core'` and from
 * `import { aharness } from '@aharness/core'` — both shapes expose `<ns>.arg`
 * (`aharness` is also re-exported as a namespace because authors commonly do
 * `aharness.machine(...)` on the same import).
 */
interface ArgBindings {
  readonly directNames: ReadonlySet<string>;
  readonly namespaceNames: ReadonlySet<string>;
  readonly createFsmFactoryNames: ReadonlySet<string>;
}

/**
 * Walk an `input: { ... }` object literal and produce a JSON Schema 7 object
 * shape plus per-field `ArgFlagMeta`. Each `<field>: arg<T>(meta?)` call
 * contributes one property; fields with no `meta.default` are listed in
 * `required`.
 *
 * Non-`arg<T>()` initialisers (e.g. raw values or unrelated calls) are
 * silently skipped — the static type system already rejects them via
 * `aharness.machine`'s `input?: Record<string, ArgSentinel>` typing.
 *
 * Empty `input: {}` returns
 * `{type: 'object', properties: {}, required: [], additionalProperties: false}`
 * and an empty `flags` map. The presence of this extraction is itself the
 * signal that the FSM declared `input`; absence is signalled at the call site
 * (the walker in `sidecar.ts` doesn't invoke this when the `input` property
 * is missing).
 */
export function extractInputFromLiteral(
  obj: ts.ObjectLiteralExpression,
  generator: SchemaGenerator,
  sf: ts.SourceFile,
  argBindings: ArgBindings,
  issues: SidecarIssue[],
): InputExtraction {
  const props: Record<string, JSONSchema7> = {};
  const flags: Record<string, ArgFlagMeta> = {};
  const required: string[] = [];
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = staticPropertyName(prop);
    if (!name) continue;
    if (!ts.isCallExpression(prop.initializer)) continue;
    const resolved = resolveInputCall(prop.initializer, argBindings);
    if (resolved === null) continue;
    if (resolved.kind === 'type' && !resolved.typeArg) {
      issues.push({
        code: 'exit-payload-missing',
        stateId: null,
        exitName: null,
        line: sf.getLineAndCharacterOfPosition(prop.getStart(sf)).line + 1,
        message: `arg<T>() at input field '${name}' has no type argument`,
      });
      continue;
    }
    let fieldSchema: JSONSchema7;
    if (resolved.kind === 'schema') {
      fieldSchema = resolved.schema;
    } else {
      try {
        fieldSchema = generator.createSchemaFromNodes([resolved.typeArg!]);
      } catch (err) {
        issues.push({
          code: 'schema-emit-failed',
          stateId: null,
          exitName: null,
          line: sf.getLineAndCharacterOfPosition(prop.getStart(sf)).line + 1,
          message: `failed to emit schema for input field '${name}': ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
    }
    props[name] = fieldSchema;
    const meta: ArgFlagMeta = readArgMetaFromCall(prop.initializer);
    flags[name] = meta;
    if (meta.default === undefined) required.push(name);
  }
  const schema: JSONSchema7 = {
    type: 'object',
    properties: props,
    required,
    additionalProperties: false,
  };
  return { schema, flags };
}

function readArgMetaFromCall(call: ts.CallExpression): ArgFlagMeta {
  const meta: { description?: string; default?: unknown; completion?: StaticCompletionKind } = {};
  const arg0 = call.arguments[0];
  if (!arg0 || !ts.isObjectLiteralExpression(arg0)) return meta;
  for (const prop of arg0.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const k = staticPropertyName(prop);
    if (!k) continue;
    if (k === 'description') {
      const v = literalString(prop.initializer);
      if (v !== null) meta.description = v;
    } else if (k === 'default') {
      const v = literalValue(prop.initializer);
      if (v !== undefined) meta.default = v;
    } else if (k === 'completion' || k === 'complete') {
      const v = readCompletion(prop.initializer);
      if (v) meta.completion = v;
    }
  }
  return meta;
}

function readCompletion(node: ts.Expression): StaticCompletionKind | null {
  const lit = literalString(node);
  if (lit === 'file' || lit === 'directory') return lit;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isIdentifier(node)) {
    return { dynamic: true };
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const k = staticPropertyName(p);
      if (k === 'values' && ts.isArrayLiteralExpression(p.initializer)) {
        const values: string[] = [];
        for (const el of p.initializer.elements) {
          const v = literalString(el);
          if (v !== null) values.push(v);
        }
        return { values };
      }
      if (k === 'dynamic') {
        return { dynamic: true };
      }
    }
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'values'
  ) {
    const valuesArg = node.arguments[0];
    if (valuesArg && ts.isArrayLiteralExpression(valuesArg)) {
      const values: string[] = [];
      for (const el of valuesArg.elements) {
        const v = literalString(el);
        if (v !== null) values.push(v);
      }
      return { values };
    }
  }
  return null;
}

function literalString(n: ts.Expression): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return null;
}

function literalValue(n: ts.Expression): unknown {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return null;
  return undefined;
}

function isArgCall(call: ts.CallExpression, bindings: ArgBindings): boolean {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return bindings.directNames.has(expr.text);
  if (ts.isPropertyAccessExpression(expr)) {
    if (!ts.isIdentifier(expr.expression)) return false;
    if (!ts.isIdentifier(expr.name)) return false;
    if (expr.name.text !== 'arg') return false;
    return bindings.namespaceNames.has(expr.expression.text);
  }
  return false;
}

type ResolvedInputCall =
  | { readonly kind: 'schema'; readonly schema: JSONSchema7 }
  | { readonly kind: 'type'; readonly typeArg: ts.TypeNode | null };

function resolveInputCall(
  call: ts.CallExpression,
  bindings: ArgBindings,
): ResolvedInputCall | null {
  if (isArgCall(call, bindings)) {
    return { kind: 'type', typeArg: extractTypeArgFromTypeCall(call) };
  }
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr)) return null;
  const inputAccess = expr.expression;
  if (!ts.isPropertyAccessExpression(inputAccess)) return null;
  if (!ts.isIdentifier(inputAccess.expression)) return null;
  if (inputAccess.name.text !== 'input') return null;
  if (!bindings.createFsmFactoryNames.has(inputAccess.expression.text)) return null;
  const helper = expr.name.text;
  if (helper === 'string' || helper === 'path')
    return { kind: 'schema', schema: { type: 'string' } };
  if (helper === 'number') return { kind: 'schema', schema: { type: 'number' } };
  if (helper === 'custom') return { kind: 'type', typeArg: extractTypeArgFromTypeCall(call) };
  return null;
}

export function collectArgBindings(
  sourceFile: ts.SourceFile,
  createFsmFactoryNames: ReadonlySet<string> = new Set(),
): ArgBindings {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    if (spec.text !== '@aharness/core') continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    if (ts.isNamedImports(bindings)) {
      for (const elem of bindings.elements) {
        const importedName = (elem.propertyName ?? elem.name).text;
        if (importedName === 'aharness') namespaces.add(elem.name.text);
        if (importedName === 'arg') direct.add(elem.name.text);
      }
    }
  }
  return { directNames: direct, namespaceNames: namespaces, createFsmFactoryNames };
}
