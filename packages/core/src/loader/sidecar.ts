/**
 * Schema sidecar extraction — `@aharness/core` §3.3.
 *
 * Given a `<file>.fsm.ts` path, walk its AST for every `state({ exits: { … } })`
 * call bound to `@aharness/core`. For each submit exit (the default kind, or
 * an explicit `kind: 'submit'`), resolve the type argument of the wrapping
 * `exit<T>(...)` factory call against a custom TypeScript program whose
 * `paths` mapping points at the aharness install (the user's project has no
 * local `node_modules` — they installed the CLI globally), emit a JSON
 * Schema, compile it with ajv, and return a `SchemaSidecar` keyed by
 * `[stateId][exitName]`.
 *
 * Await exits (`kind: 'await'`) are plain object literals (not wrapped in
 * `exit<T>()`), carry no payload, and produce no sidecar entry; the AST
 * walker just skips them.
 *
 * The compiled schemas use Draft-07 — `ts-json-schema-generator`'s default
 * output dialect. `SPEC_SDK.md` §3.3 names Draft 2020-12 / OpenAPI-3.1; the
 * example FSMs use only object/union/array/primitive shapes for which
 * Draft-07 is a strict subset. If a future user needs 2020-12 features
 * (`prefixItems`, `dependentSchemas`) the loader will switch generator
 * config and `Ajv2020`. Today, staying on the lib's default avoids a
 * configuration knob whose only payoff would be unused features.
 *
 * The default ajv constructor accepts Draft-07; we run with `allErrors: true`
 * so a single invalid submit surfaces every problem at once.
 *
 * Implementation notes:
 *   - We build the `ts.Program` ourselves (not via `ts-json-schema-generator`'s
 *     `createProgram`) so we can inject the `paths` mapping that points at
 *     the aharness install. The lib re-exports its own `typescript` so we use
 *     that to avoid the dual-version-typings conflict between this package's
 *     `typescript@6.x` and the lib's pinned `typescript@5.x`.
 *   - The walked AST nodes (`SourceFile.statements`, type arguments) come
 *     from the lib's `ts` instance and feed back into the lib's
 *     `SchemaGenerator`; using the lib's `ts` end-to-end keeps `ts.Node`
 *     types unified.
 *   - The ajv import goes through a CJS-default-shape unwrap because
 *     ajv@8 publishes both `module.exports = Ajv` and `exports.default = Ajv`
 *     and `tsc` under NodeNext picks the namespace shape, not the class.
 *   - The `state` call is recognised via a dedicated AST scan (rather than
 *     reusing `binding.ts` which targets the legacy `submit` export).
 *     `binding.ts` is owned by a sibling task and intentionally untouched.
 */

import {
  createParser,
  createFormatter,
  SchemaGenerator,
  ts,
  DEFAULT_CONFIG,
  type CompletedConfig,
} from 'ts-json-schema-generator';
import * as path from 'node:path';
import { Ajv, type Schema, type ValidateFunction } from 'ajv';
import type { JSONSchema7 } from 'json-schema';
import type { SchemaSidecar, SidecarValidateResult, ValidationError } from '../types.js';
import { getEnclosingStateId } from './stateId.js';
import { getInstallPaths, type InstallPaths } from './installPath.js';
import { collectArgBindings, extractInputFromLiteral, type ArgFlagMeta } from './inputSchema.js';
import {
  resolveDirectFsmImport,
  resolvePackageSourceImport,
  type PackageResolutionContext,
} from './packageResolution.js';

// `ajv@8` does `module.exports = Ajv` on the CJS side and re-exports the
// class via the named `Ajv` export. The named import resolves to a
// constructable type under NodeNext; the bare `import Ajv from 'ajv'`
// form does not (TS picks the module-namespace shape, which has no
// construct signature).
type AjvInstance = InstanceType<typeof Ajv>;

// Accepted import source for the SDK author surface. `@aharness/core`
// is the codex-substrate authoring barrel; FSMs targeting the codex
// substrate import their primitives (`state`, `aharness`, ...) from there.
const SDK_MODULE_SPECIFIERS: ReadonlySet<string> = new Set(['@aharness/core']);
const XSTATE_MODULE_SPECIFIER = 'xstate';

export interface SidecarExtractionOptions {
  readonly filePath: string;
  readonly packageResolution?: PackageResolutionContext;
  /**
   * Set of absolute file paths currently on the recursion stack. Used to break
   * cycles when a parent embeds a child that (transitively) embeds the parent.
   * The runtime verifier check `embedding-acyclic` is the authoritative
   * detector; this guard is a process-termination safety net so the loader
   * does not infinite-loop before the verifier runs.
   */
  readonly cycleGuard?: ReadonlySet<string>;
}

export interface SidecarExtractionResult {
  readonly sidecar: SchemaSidecar;
  readonly issues: readonly SidecarIssue[];
  /**
   * Top-level JSON Schema for the FSM's `input` declaration. Present iff the
   * file's default export resolves to a `aharness.machine({input: {...}, ...})`
   * call. Empty `input: {}` produces a non-null but empty schema (zero
   * required fields, zero properties) — distinguishable from "no input
   * declaration", where this property is `undefined`.
   */
  readonly inputSchema?: JSONSchema7;
  /**
   * Per-field `arg<T>(meta?)` metadata: description, default, completion.
   * Always present alongside `inputSchema`; absent otherwise.
   */
  readonly inputFlags?: Record<string, ArgFlagMeta>;
}

/**
 * Issue codes emitted by the extractor:
 *   - `state-call-misplaced` — `state(...)` not inside a `states: { ... }` chain.
 *   - `exit-payload-missing` — submit exit is not wrapped in `exit<T>(...)` (or the wrapping call has no type argument).
 *   - `exit-payload-any` — submit exit declares `exit<any>(...)`.
 *   - `exit-payload-unknown` — submit exit declares `exit<unknown>(...)`.
 *   - `exit-payload-never` — submit exit declares `exit<never>(...)`.
 *   - `await-with-payload` — await exit is wrapped in `exit<T>(...)` (illegal — await exits are plain object literals).
 *   - `schema-emit-failed` — `ts-json-schema-generator` threw on the type argument.
 *   - `validator-compile-failed` — ajv refused to compile the emitted schema.
 *   - `author-fn-async` — `entryPrompt` or `stopGuidance` is declared as
 *     an async function or annotated as `Promise<…>`-returning. These callbacks
 *     run inline on the runtime hot path and must be sync.
 *   - `direct-create-machine` — `xstate.createMachine(...)` is called on a
 *     config containing a stateful state. Stateful states require the
 *     framework actions injected by `aharness.machine(...)` (visit counts,
 *     owner-reply assignment); bypassing the wrapper silently breaks them.
 *
 * `stateId` is null for `state-call-misplaced` and `direct-create-machine`;
 * `exitName` is null for any issue that is not tied to a specific exit.
 */
export type SidecarIssueCode =
  | 'state-call-misplaced'
  | 'exit-payload-missing'
  | 'exit-payload-any'
  | 'exit-payload-unknown'
  | 'exit-payload-never'
  | 'await-with-payload'
  | 'schema-emit-failed'
  | 'exit-payload-non-object'
  | 'validator-compile-failed'
  | 'author-fn-async'
  | 'direct-create-machine';

export interface SidecarIssue {
  readonly code: SidecarIssueCode;
  readonly stateId: string | null;
  readonly exitName: string | null;
  readonly message: string;
  /** 1-indexed line in the source file. */
  readonly line: number;
}

/**
 * Build the schema sidecar for `filePath`. Throws on unrecoverable errors
 * (file not found). Returns issues for recoverable cases (missing payload,
 * untyped payload, generator failure).
 */
export async function extractSchemaSidecar(
  opts: SidecarExtractionOptions,
): Promise<SidecarExtractionResult> {
  const installPaths = await getInstallPaths();
  const program = buildProgram(opts.filePath, installPaths, opts.packageResolution);
  const sourceFile = program.getSourceFile(opts.filePath);
  if (!sourceFile) {
    throw new Error(
      `extractSchemaSidecar: TypeScript program contains no SourceFile for '${opts.filePath}'.`,
    );
  }

  const createFsmFactoryNames = collectCreateFsmFactoryNames(sourceFile);
  const stateBindings = collectStateBindings(sourceFile, createFsmFactoryNames);
  const exitBindings = collectExitBindings(sourceFile);
  const xstateBindings = collectXstateCreateMachineBindings(sourceFile);
  if (
    stateBindings.directNames.size === 0 &&
    stateBindings.namespaceNames.size === 0 &&
    createFsmFactoryNames.size === 0
  ) {
    return { sidecar: {}, issues: [] };
  }

  const completed: CompletedConfig = {
    ...DEFAULT_CONFIG,
    expose: 'export',
    topRef: false,
    skipTypeCheck: true,
    additionalProperties: false,
  };
  const parser = createParser(program, completed);
  const formatter = createFormatter(completed);
  const generator = new SchemaGenerator(program, parser, formatter, completed);

  const ajv = new Ajv({ allErrors: true, strict: false });
  const checker = program.getTypeChecker();

  type ExitEntry = NonNullable<NonNullable<SchemaSidecar[string]>[string]>;
  const sidecar: Record<string, Record<string, ExitEntry>> = {};
  const issues: SidecarIssue[] = [];

  // Bind the narrowed source file into the closure; TS doesn't propagate
  // the `if (!sourceFile) throw` narrowing into the nested `visit` closure.
  const sf: ts.SourceFile = sourceFile;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isStateCall(node, stateBindings)) {
      processStateCall(node);
    }
    ts.forEachChild(node, visit);
  }

  function processStateCall(node: ts.CallExpression): void {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const stateId = getEnclosingStateId(node);
    if (stateId === null) {
      issues.push({
        code: 'state-call-misplaced',
        stateId: null,
        exitName: null,
        line,
        message:
          "state({ ... }) call is not inside a 'states: { … }' chain — cannot determine state id",
      });
      return;
    }
    const arg = node.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return;

    checkAuthorFunctionsSync(arg, stateId, sf, issues);

    const exitsProp = findProperty(arg, 'exits');
    if (exitsProp && ts.isObjectLiteralExpression(exitsProp.initializer)) {
      processExitMap(exitsProp.initializer, stateId);
    }

    const onProp = findProperty(arg, 'on');
    if (onProp && ts.isObjectLiteralExpression(onProp.initializer)) {
      processCanonicalOnMap(onProp.initializer, stateId);
    }
  }

  function processExitMap(exits: ts.ObjectLiteralExpression, stateId: string): void {
    for (const exitProp of exits.properties) {
      if (!ts.isPropertyAssignment(exitProp)) continue;
      const exitName = staticPropertyName(exitProp);
      if (exitName === null) continue;
      const exitLine = sf.getLineAndCharacterOfPosition(exitProp.getStart(sf)).line + 1;

      // The exit's value-position AST shape determines the path:
      //   1. CallExpression to `exit<T>(...)` ⇒ submit exit; type arg is `T`.
      //   2. Plain object literal with `kind: 'await'` ⇒ await exit (skipped).
      //   3. Plain object literal without `kind: 'await'` ⇒ author forgot the
      //      `exit<T>(...)` wrapper on a submit exit; reject as missing.
      const exitValue = exitProp.initializer;
      const typeArgNode = ((): ts.TypeNode | null => {
        if (ts.isCallExpression(exitValue) && isExitCall(exitValue, exitBindings)) {
          // Author wrapped in `exit<T>(...)`. Detect the misuse where a
          // `kind: 'await'` slipped inside the factory's argument literal —
          // that's an authoring error (await exits never go through `exit()`).
          const argLit = exitValue.arguments[0];
          if (argLit && ts.isObjectLiteralExpression(argLit)) {
            const kindProp = findProperty(argLit, 'kind');
            const kindLiteral = kindProp ? getStringLiteralValue(kindProp.initializer) : null;
            if (kindLiteral === 'await') {
              issues.push({
                code: 'await-with-payload',
                stateId,
                exitName,
                line: exitLine,
                message: `await exit '${stateId}::${exitName}' must be a plain object literal, not wrapped in exit<T>(...)`,
              });
              return null;
            }
          }
          const node = extractTypeArgFromTypeCall(exitValue);
          if (!node) {
            issues.push({
              code: 'exit-payload-missing',
              stateId,
              exitName,
              line: exitLine,
              message: `submit exit '${stateId}::${exitName}' has no type argument on exit<T>(...) — write 'exit<MyPayload>({...})'`,
            });
            return null;
          }
          return node;
        }
        if (ts.isObjectLiteralExpression(exitValue)) {
          const kindProp = findProperty(exitValue, 'kind');
          const kindLiteral = kindProp ? getStringLiteralValue(kindProp.initializer) : null;
          if (kindLiteral === 'await') {
            // Pure await exit — no schema sidecar entry.
            return null;
          }
          // Plain object literal that isn't an await exit ⇒ author wrote a submit
          // exit without the `exit<T>(...)` wrapper.
          issues.push({
            code: 'exit-payload-missing',
            stateId,
            exitName,
            line: exitLine,
            message: `submit exit '${stateId}::${exitName}' is missing the exit<T>({...}) wrapper`,
          });
          return null;
        }
        // Some other expression at the exit's value position (identifier
        // reference, conditional, etc.) — the loader cannot statically
        // resolve the payload type. Skip with a missing-anchor issue.
        issues.push({
          code: 'exit-payload-missing',
          stateId,
          exitName,
          line: exitLine,
          message: `submit exit '${stateId}::${exitName}' is not a recognised exit<T>(...) call or await literal — only those two shapes are supported`,
        });
        return null;
      })();
      if (typeArgNode === null) continue;
      emitSubmitSchema(typeArgNode, stateId, exitName, exitLine);
    }
  }

  function processCanonicalOnMap(on: ts.ObjectLiteralExpression, stateId: string): void {
    for (const exitProp of on.properties) {
      if (!ts.isPropertyAssignment(exitProp)) continue;
      const exitName = staticPropertyName(exitProp);
      if (exitName === null) continue;
      const exitLine = sf.getLineAndCharacterOfPosition(exitProp.getStart(sf)).line + 1;
      const value = exitProp.initializer;
      if (!ts.isCallExpression(value)) {
        if (ts.isObjectLiteralExpression(value)) {
          // Canonical custom events and built-in hook events are authored as
          // plain object handlers under `on`. They do not have submit payload
          // schemas; construction/verifier checks own their event shape.
          continue;
        }
        issues.push({
          code: 'exit-payload-missing',
          stateId,
          exitName,
          line: exitLine,
          message: `canonical submit '${stateId}::${exitName}' is not a recognised fsm.submit<T>(...) call`,
        });
        continue;
      }
      if (isCanonicalAwaitCall(value, createFsmFactoryNames)) {
        if (value.typeArguments && value.typeArguments.length > 0) {
          issues.push({
            code: 'await-with-payload',
            stateId,
            exitName,
            line: exitLine,
            message: `canonical await exit '${stateId}::${exitName}' must not declare a payload type`,
          });
        }
        continue;
      }
      if (!isCanonicalSubmitCall(value, createFsmFactoryNames)) {
        issues.push({
          code: 'exit-payload-missing',
          stateId,
          exitName,
          line: exitLine,
          message: `canonical submit '${stateId}::${exitName}' is not a recognised fsm.submit<T>(...) call`,
        });
        continue;
      }
      const typeArgNode = extractTypeArgFromTypeCall(value);
      if (!typeArgNode) {
        issues.push({
          code: 'exit-payload-missing',
          stateId,
          exitName,
          line: exitLine,
          message: `canonical submit '${stateId}::${exitName}' has no type argument on fsm.submit<T>(...)`,
        });
        continue;
      }
      emitSubmitSchema(typeArgNode, stateId, exitName, exitLine);
    }
  }

  function emitSubmitSchema(
    typeArgNode: ts.TypeNode,
    stateId: string,
    exitName: string,
    exitLine: number,
  ): void {
    const untyped = classifyUntyped(checker, typeArgNode);
    if (untyped !== null) {
      const code: SidecarIssueCode =
        untyped === 'any'
          ? 'exit-payload-any'
          : untyped === 'unknown'
            ? 'exit-payload-unknown'
            : 'exit-payload-never';
      issues.push({
        code,
        stateId,
        exitName,
        line: exitLine,
        message: `submit exit '${stateId}::${exitName}' has untyped payload <${untyped}>; declare a concrete type so the framework can validate submissions`,
      });
      return;
    }

    let schema: JSONSchema7;
    try {
      schema = generator.createSchemaFromNodes([typeArgNode]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push({
        code: 'schema-emit-failed',
        stateId,
        exitName,
        line: exitLine,
        message: `failed to emit JSON Schema for exit '${stateId}::${exitName}': ${msg}`,
      });
      return;
    }

    const checked = requireObjectInputSchema(schema);
    if (!checked.ok) {
      issues.push({
        code: 'exit-payload-non-object',
        stateId,
        exitName,
        line: exitLine,
        message: `exit<T>(...) at state '${stateId}::${exitName}' yields a non-object input schema (${checked.reason}); MCP requires object payloads — wrap the type, e.g. 'exit<{ value: T }>({...})'`,
      });
      return;
    }
    schema = checked.schema;

    const compiled = compileValidator(ajv, schema);
    if (!compiled) {
      issues.push({
        code: 'validator-compile-failed',
        stateId,
        exitName,
        line: exitLine,
        message: `failed to compile ajv validator for exit '${stateId}::${exitName}'`,
      });
      return;
    }

    const stateSlot = sidecar[stateId] ?? {};
    stateSlot[exitName] = {
      jsonSchema: schema,
      validate: makeValidate(compiled),
    };
    sidecar[stateId] = stateSlot;
  }
  visit(sourceFile);

  const childResults = await resolveAndExtractChildSidecars(
    sourceFile,
    opts.filePath,
    opts.cycleGuard ?? new Set([opts.filePath]),
    opts.packageResolution,
  );
  for (const { hostKey, childSidecar, childIssues } of childResults) {
    for (const childStateId of Object.keys(childSidecar)) {
      const exits = childSidecar[childStateId];
      if (!exits) continue;
      const qualifiedId = `${hostKey}.${childStateId}`;
      const existing = sidecar[qualifiedId] ?? {};
      const merged: Record<string, ExitEntry> = { ...existing };
      for (const exitName of Object.keys(exits)) {
        const entry = exits[exitName];
        if (entry) merged[exitName] = entry;
      }
      sidecar[qualifiedId] = merged;
    }
    for (const iss of childIssues) {
      issues.push({
        ...iss,
        stateId: iss.stateId === null ? null : `${hostKey}.${iss.stateId}`,
      });
    }
  }

  checkDirectCreateMachine(sf, xstateBindings, stateBindings, issues);

  // Input-schema extraction: locate the file's default-export `aharness.machine(...)`
  // call, find its `input: {...}` literal, and walk each `arg<T>(...)` field
  // through the same `ts-json-schema-generator` path used for submit payloads.
  // The walker's multi-machine guard skips files whose default export does not
  // resolve to a single `aharness.machine` call.
  const machineBindings = collectMachineBindings(sourceFile, createFsmFactoryNames);
  const argBindings = collectArgBindings(sourceFile, createFsmFactoryNames);
  let inputSchema: JSONSchema7 | undefined;
  let inputFlags: Record<string, ArgFlagMeta> | undefined;

  const machineCall = findDefaultExportMachineCall(sourceFile, machineBindings);
  if (machineCall) {
    const machineArg0 = machineCall.arguments[0];
    if (machineArg0 && ts.isObjectLiteralExpression(machineArg0)) {
      const inputProp = findProperty(machineArg0, 'input');
      if (inputProp && ts.isObjectLiteralExpression(inputProp.initializer)) {
        const result = extractInputFromLiteral(
          inputProp.initializer,
          generator,
          sf,
          argBindings,
          issues,
        );
        inputSchema = result.schema;
        inputFlags = result.flags;
      }
    }
  }

  if (inputSchema && inputFlags) {
    return { sidecar, issues, inputSchema, inputFlags };
  }
  return { sidecar, issues };
}

/**
 * For each `<hostKey>: embed(<childIdent>, …)` call site directly under the
 * parent's `states: { … }` map, return `{hostKey, childTsPath}` where
 * `childTsPath` is the resolved absolute path of the child FSM's `.ts`
 * source. Children that re-export through a non-default form are out of
 * scope — only `import <name> from './<rel>.fsm.js'` is recognised.
 */
async function resolveAndExtractChildSidecars(
  sourceFile: ts.SourceFile,
  parentFilePath: string,
  cycleGuard: ReadonlySet<string>,
  packageResolution: PackageResolutionContext | undefined,
): Promise<
  Array<{
    hostKey: string;
    childSidecar: SchemaSidecar;
    childIssues: SidecarIssue[];
  }>
> {
  const fsmImports = collectFsmDefaultImports(sourceFile, parentFilePath, packageResolution);
  if (fsmImports.size === 0) return [];

  const machineBindings = collectMachineBindings(
    sourceFile,
    collectCreateFsmFactoryNames(sourceFile),
  );
  const embedBindings = collectEmbedBindings(sourceFile, collectCreateFsmFactoryNames(sourceFile));
  const machineCall = findDefaultExportMachineCall(sourceFile, machineBindings);
  if (!machineCall) return [];
  const machineArg0 = machineCall.arguments[0];
  if (!machineArg0 || !ts.isObjectLiteralExpression(machineArg0)) return [];
  const statesProp = findProperty(machineArg0, 'states');
  if (!statesProp || !ts.isObjectLiteralExpression(statesProp.initializer)) return [];

  const embedHosts: Array<{ hostKey: string; childTsPath: string }> = [];
  for (const prop of statesProp.initializer.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const hostKey = staticPropertyName(prop);
    if (!hostKey) continue;
    const init = unwrapTypeAssertion(prop.initializer);
    if (!ts.isCallExpression(init)) continue;
    if (!isEmbedCall(init, embedBindings)) continue;
    const firstArg = init.arguments[0];
    if (!firstArg || !ts.isIdentifier(firstArg)) continue;
    const childTsPath = fsmImports.get(firstArg.text);
    if (!childTsPath) continue;
    embedHosts.push({ hostKey, childTsPath });
  }

  const results: Array<{
    hostKey: string;
    childSidecar: SchemaSidecar;
    childIssues: SidecarIssue[];
  }> = [];
  for (const { hostKey, childTsPath } of embedHosts) {
    if (cycleGuard.has(childTsPath)) continue;
    const nextGuard = new Set(cycleGuard);
    nextGuard.add(childTsPath);
    const childResult = await extractSchemaSidecar({
      filePath: childTsPath,
      cycleGuard: nextGuard,
      ...(packageResolution ? { packageResolution } : {}),
    });
    results.push({
      hostKey,
      childSidecar: childResult.sidecar,
      childIssues: [...childResult.issues],
    });
  }
  return results;
}

/**
 * Map default import names → resolved child `.ts` source paths for every
 * `import <name> from './<rel>.fsm.js'` declaration in the file. Only the
 * `.fsm.js` suffix is recognised — the aharness convention. The `.js` suffix
 * is rewritten to `.ts` for source resolution; under NodeNext the user's
 * source is `.ts` and the import specifier is `.js`.
 */
function collectFsmDefaultImports(
  sourceFile: ts.SourceFile,
  parentFilePath: string,
  packageResolution: PackageResolutionContext | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    if (!spec.text.endsWith('.fsm.js')) continue;
    const defaultName = stmt.importClause?.name?.text;
    if (!defaultName) continue;
    const tsPath = packageResolution
      ? resolvePackageSourceImport({
          importerFile: parentFilePath,
          specifier: spec.text,
          packageResolution,
        })
      : resolveDirectFsmImport(parentFilePath, spec.text);
    if (!tsPath) continue;
    out.set(defaultName, tsPath);
  }
  return out;
}

interface EmbedBindings {
  readonly directNames: ReadonlySet<string>;
  readonly namespaceNames: ReadonlySet<string>;
}

function collectEmbedBindings(
  sourceFile: ts.SourceFile,
  createFsmFactoryNames: ReadonlySet<string> = new Set(),
): EmbedBindings {
  const direct = new Set<string>();
  const namespaces = new Set<string>(createFsmFactoryNames);
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    if (!SDK_MODULE_SPECIFIERS.has(spec.text)) continue;
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
        if (importedName === 'embed') direct.add(elem.name.text);
      }
    }
  }
  return { directNames: direct, namespaceNames: namespaces };
}

function isEmbedCall(call: ts.CallExpression, bindings: EmbedBindings): boolean {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) {
    return bindings.directNames.has(expr.text);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    if (!ts.isIdentifier(expr.expression)) return false;
    if (!ts.isIdentifier(expr.name)) return false;
    if (expr.name.text !== 'embed') return false;
    return bindings.namespaceNames.has(expr.expression.text);
  }
  return false;
}

/**
 * Strip surrounding `as <Type>` / `<Type>...` / parenthesised type
 * assertions so the underlying expression (e.g. an `embed()` call
 * coerced via `as never`) is reached. XState 5's typed `StateNodeConfig`
 * does not yet accept `EmbeddedCompoundConfig` structurally, so authors
 * write `embed(child, {...}) as never` on the parent's `states:` map;
 * the loader's AST scan must look through that cast to detect the
 * embed-host.
 */
function unwrapTypeAssertion(node: ts.Expression): ts.Expression {
  let cur: ts.Expression = node;
  while (
    ts.isAsExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isParenthesizedExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

interface StateBindings {
  readonly directNames: ReadonlySet<string>;
  readonly namespaceNames: ReadonlySet<string>;
}

/**
 * Collect identifier names bound to the `state` export of
 * `@aharness/core`.
 *
 * Mirrors the strategy of `./binding.ts` for `submit`, but kept inline so
 * `binding.ts` remains untouched (it is owned by a sibling task that
 * generalises bindings across the new export surface).
 */
function collectStateBindings(
  sourceFile: ts.SourceFile,
  createFsmFactoryNames: ReadonlySet<string> = new Set(),
): StateBindings {
  const direct = new Set<string>();
  const namespaces = new Set<string>(createFsmFactoryNames);
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    if (!SDK_MODULE_SPECIFIERS.has(spec.text)) continue;
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
        if (importedName === 'state') direct.add(elem.name.text);
      }
    }
  }
  return { directNames: direct, namespaceNames: namespaces };
}

interface MachineBindings {
  /** Identifier names imported as `machine` from `@aharness/core` (rare). */
  readonly directNames: ReadonlySet<string>;
  /**
   * Identifier names exposing `<ns>.machine` — `import * as ns` and the
   * common `import { aharness }` form (the `aharness` re-export is a
   * namespace-shaped object whose `.machine(...)` member is the constructor).
   */
  readonly namespaceNames: ReadonlySet<string>;
}

/**
 * Collect identifier names that resolve to `aharness.machine` (or a bare
 * `machine` import) on the SDK author surface.
 *
 * Mirrors `collectStateBindings` for the machine-constructor side. The
 * downstream `findDefaultExportMachineCall` walker uses these to recognise
 * the FSM's root call regardless of the user's import style.
 */
function collectMachineBindings(
  sourceFile: ts.SourceFile,
  createFsmFactoryNames: ReadonlySet<string> = new Set(),
): MachineBindings {
  const direct = new Set<string>();
  const namespaces = new Set<string>(createFsmFactoryNames);
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    if (!SDK_MODULE_SPECIFIERS.has(spec.text)) continue;
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
        if (importedName === 'machine') direct.add(elem.name.text);
      }
    }
  }
  return { directNames: direct, namespaceNames: namespaces };
}

function isMachineCall(call: ts.CallExpression, bindings: MachineBindings): boolean {
  const expr = call.expression;
  if (ts.isPropertyAccessExpression(expr)) {
    if (!ts.isIdentifier(expr.expression)) return false;
    if (!ts.isIdentifier(expr.name)) return false;
    if (expr.name.text !== 'machine') return false;
    return bindings.namespaceNames.has(expr.expression.text);
  }
  if (ts.isIdentifier(expr)) {
    return bindings.directNames.has(expr.text);
  }
  return false;
}

function collectCreateFsmFactoryNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const directCreateFsmNames = new Set<string>();
  const namespaceNames = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    if (!SDK_MODULE_SPECIFIERS.has(spec.text)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaceNames.add(bindings.name.text);
      continue;
    }
    for (const elem of bindings.elements) {
      const importedName = (elem.propertyName ?? elem.name).text;
      if (importedName === 'createFsm') directCreateFsmNames.add(elem.name.text);
    }
  }

  const factories = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const init = decl.initializer;
      if (!ts.isCallExpression(init)) continue;
      const expr = init.expression;
      if (ts.isIdentifier(expr) && directCreateFsmNames.has(expr.text)) {
        factories.add(decl.name.text);
        continue;
      }
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        namespaceNames.has(expr.expression.text) &&
        expr.name.text === 'createFsm'
      ) {
        factories.add(decl.name.text);
        continue;
      }
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        factories.has(expr.expression.text) &&
        expr.name.text === 'withEvents'
      ) {
        factories.add(decl.name.text);
        continue;
      }
      if (
        ts.isPropertyAccessExpression(expr) &&
        expr.name.text === 'withEvents' &&
        ts.isCallExpression(expr.expression) &&
        isCreateFsmCallExpression(expr.expression, directCreateFsmNames, namespaceNames)
      ) {
        factories.add(decl.name.text);
      }
    }
  }
  return factories;
}

function isCreateFsmCallExpression(
  call: ts.CallExpression,
  directCreateFsmNames: ReadonlySet<string>,
  namespaceNames: ReadonlySet<string>,
): boolean {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return directCreateFsmNames.has(expr.text);
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    namespaceNames.has(expr.expression.text) &&
    expr.name.text === 'createFsm'
  );
}

function isCanonicalSubmitCall(
  call: ts.CallExpression,
  createFsmFactoryNames: ReadonlySet<string>,
): boolean {
  return isCanonicalFactoryMemberCall(call, createFsmFactoryNames, 'submit');
}

function isCanonicalAwaitCall(
  call: ts.CallExpression,
  createFsmFactoryNames: ReadonlySet<string>,
): boolean {
  return isCanonicalFactoryMemberCall(call, createFsmFactoryNames, 'await');
}

function isCanonicalFactoryMemberCall(
  call: ts.CallExpression,
  createFsmFactoryNames: ReadonlySet<string>,
  member: string,
): boolean {
  const expr = call.expression;
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    createFsmFactoryNames.has(expr.expression.text) &&
    expr.name.text === member
  );
}

/**
 * Locate the file's default-export `aharness.machine(...)` call.
 *
 * Two source shapes are recognised:
 *   1. `export default aharness.machine({...});` — direct
 *   2. `const m = aharness.machine({...}); export default m;` — via identifier
 *
 * Returns null when:
 *   - The file has no default export.
 *   - The default export does not resolve to a `aharness.machine` call.
 *   - Multiple `aharness.machine` calls exist and the default export is
 *     ambiguous (e.g. `export default condition ? a : b`).
 *
 * The multi-machine guard prevents picking up `helper = aharness.machine({...})`
 * declarations elsewhere in the file when those are never the default export —
 * input extraction simply skips the file in that case.
 */
function findDefaultExportMachineCall(
  sourceFile: ts.SourceFile,
  bindings: MachineBindings,
): ts.CallExpression | null {
  // Pass A: collect identifier→callExpression for `const X = aharness.machine(...)`.
  const machineByIdent = new Map<string, ts.CallExpression>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      if (!ts.isCallExpression(decl.initializer)) continue;
      if (!isMachineCall(decl.initializer, bindings)) continue;
      if (ts.isIdentifier(decl.name)) {
        machineByIdent.set(decl.name.text, decl.initializer);
      }
    }
  }
  // Pass B: scan for `export default …`.
  for (const stmt of sourceFile.statements) {
    if (!ts.isExportAssignment(stmt)) continue;
    if (stmt.isExportEquals) continue;
    const expr = stmt.expression;
    if (ts.isCallExpression(expr) && isMachineCall(expr, bindings)) {
      return expr;
    }
    if (ts.isIdentifier(expr)) {
      const cached = machineByIdent.get(expr.text);
      if (cached) return cached;
    }
  }
  return null;
}

interface XstateCreateMachineBindings {
  /** Identifier names imported as `createMachine` from `xstate` (incl. renames). */
  readonly directNames: ReadonlySet<string>;
  /** Identifier names bound via `import * as <ns> from 'xstate'`; matches `<ns>.createMachine`. */
  readonly namespaceNames: ReadonlySet<string>;
}

/**
 * Collect identifier names bound to `xstate.createMachine`.
 *
 * Mirrors `collectStateBindings` but for the xstate side. The downstream
 * `direct-create-machine` check only fires when the AST shows a stateful
 * state in scope; bypassing the wrapper is fine for stateless machines, so
 * recording the binding is cheap insurance, not a hard policy.
 */
function collectXstateCreateMachineBindings(
  sourceFile: ts.SourceFile,
): XstateCreateMachineBindings {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    if (spec.text !== XSTATE_MODULE_SPECIFIER) continue;
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
        if (importedName === 'createMachine') direct.add(elem.name.text);
      }
    }
  }
  return { directNames: direct, namespaceNames: namespaces };
}

function isStateCall(call: ts.CallExpression, bindings: StateBindings): boolean {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) {
    return bindings.directNames.has(expr.text);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    if (!ts.isIdentifier(expr.expression)) return false;
    if (!ts.isIdentifier(expr.name)) return false;
    if (expr.name.text !== 'state') return false;
    return bindings.namespaceNames.has(expr.expression.text);
  }
  return false;
}

interface ExitBindings {
  readonly directNames: ReadonlySet<string>;
  readonly namespaceNames: ReadonlySet<string>;
}

/**
 * Collect identifier names bound to the `exit` factory export of
 * `@aharness/core`. Mirrors `collectStateBindings` for the per-exit submit
 * factory; the loader uses the binding set to recognise `exit<T>(...)`
 * calls at exit value positions.
 */
function collectExitBindings(sourceFile: ts.SourceFile): ExitBindings {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    if (!SDK_MODULE_SPECIFIERS.has(spec.text)) continue;
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
        if (importedName === 'exit') direct.add(elem.name.text);
      }
    }
  }
  return { directNames: direct, namespaceNames: namespaces };
}

function isExitCall(call: ts.CallExpression, bindings: ExitBindings): boolean {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) {
    return bindings.directNames.has(expr.text);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    if (!ts.isIdentifier(expr.expression)) return false;
    if (!ts.isIdentifier(expr.name)) return false;
    if (expr.name.text !== 'exit') return false;
    return bindings.namespaceNames.has(expr.expression.text);
  }
  return false;
}

/**
 * True when `call` resolves to `xstate.createMachine` either as a bare
 * imported identifier or as `<ns>.createMachine` on a namespace import.
 */
function isXstateCreateMachineCall(
  call: ts.CallExpression,
  bindings: XstateCreateMachineBindings,
): boolean {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) {
    return bindings.directNames.has(expr.text);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    if (!ts.isIdentifier(expr.expression)) return false;
    if (!ts.isIdentifier(expr.name)) return false;
    if (expr.name.text !== 'createMachine') return false;
    return bindings.namespaceNames.has(expr.expression.text);
  }
  return false;
}

/**
 * Walk the source file looking for `xstate.createMachine(...)` calls. If the
 * argument is an object literal whose `states: { … }` chain contains any
 * `meta: { aharness: state({...}) }` entry, emit `direct-create-machine`. The
 * fix is to call `aharness.machine(...)` instead — the wrapper injects the
 * framework actions (`__aharnessIncrementVisit`, owner-reply assigners) that
 * stateful states rely on.
 *
 * The check fires once per offending `createMachine` call. The detection of
 * a stateful state inside the config is purely syntactic: we look for a
 * `meta.aharness = state(...)` shape, where `state` resolves to the SDK
 * binding the sidecar walker already tracks. This avoids false positives on
 * machines that happen to use other `meta` payloads.
 */
function checkDirectCreateMachine(
  sourceFile: ts.SourceFile,
  xstateBindings: XstateCreateMachineBindings,
  stateBindings: StateBindings,
  issues: SidecarIssue[],
): void {
  if (xstateBindings.directNames.size === 0 && xstateBindings.namespaceNames.size === 0) {
    return;
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isXstateCreateMachineCall(node, xstateBindings)) {
      const config = node.arguments[0];
      if (config && containsStatefulState(config, stateBindings)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        issues.push({
          code: 'direct-create-machine',
          stateId: null,
          exitName: null,
          line,
          message:
            'createMachine() called directly on a config containing stateful states; use aharness.machine(...) instead',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/**
 * Recursively check whether `node` (typically the first argument of a
 * `createMachine(...)` call) contains a `meta: { aharness: state(...) }`
 * property anywhere in its `states` tree. The check is intentionally
 * structural — it does not require type-checker resolution.
 */
function containsStatefulState(node: ts.Node, stateBindings: StateBindings): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAssignment(n) && staticPropertyName(n) === 'aharness') {
      const init = n.initializer;
      if (ts.isCallExpression(init) && isStateCall(init, stateBindings)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * Reject `entryPrompt` and `stopGuidance` declared as `async` arrow /
 * function expressions, or annotated to return `Promise<…>`. These callbacks
 * are invoked synchronously on the runtime hot path (orientation composition
 * and drive-forward nudges); a Promise-returning impl would silently break the contract
 * without any helpful error from XState.
 *
 * The check is purely syntactic — we do not run the type-checker over the
 * function body. A user who calls an async function from a sync wrapper
 * still produces sync surface syntax, and we accept that. This mirrors the
 * SDK's general "trust what the AST says, verify what the type system can
 * prove" stance.
 */
function checkAuthorFunctionsSync(
  arg: ts.ObjectLiteralExpression,
  stateId: string,
  sf: ts.SourceFile,
  issues: SidecarIssue[],
): void {
  for (const propName of ['entryPrompt', 'stopGuidance'] as const) {
    const prop = findProperty(arg, propName);
    if (!prop) continue;
    const init = prop.initializer;
    if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue;
    const line = sf.getLineAndCharacterOfPosition(prop.getStart(sf)).line + 1;
    const isAsync = init.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
    if (isAsync) {
      issues.push({
        code: 'author-fn-async',
        stateId,
        exitName: null,
        line,
        message: `${propName} on '${stateId}' is async; must be sync`,
      });
      continue;
    }
    const returnType = init.type;
    if (
      returnType &&
      ts.isTypeReferenceNode(returnType) &&
      returnType.typeName.getText() === 'Promise'
    ) {
      issues.push({
        code: 'author-fn-async',
        stateId,
        exitName: null,
        line,
        message: `${propName} on '${stateId}' returns Promise; must be sync`,
      });
    }
  }
}

export function findProperty(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | null {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (staticPropertyName(prop) === name) return prop;
  }
  return null;
}

export function staticPropertyName(pa: ts.PropertyAssignment): string | null {
  const name = pa.name;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

function getStringLiteralValue(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * Pull the first type argument off a `<T>(...)` call expression. Returns
 * null if `expr` is not a CallExpression or has no type arguments.
 *
 * Used by both the submit-exit walker (`exit<T>({...})` value position)
 * and the input-field walker (`arg<T>(...)` field initializer in
 * `loader/inputSchema.ts`). Any other right-hand side (an identifier
 * referencing an externally-built sentinel, a function call returning a
 * marker, etc.) cannot be statically resolved and is rejected upstream
 * by the call site as `exit-payload-missing` or its input-side analogue.
 */
export function extractTypeArgFromTypeCall(expr: ts.Expression): ts.TypeNode | null {
  if (!ts.isCallExpression(expr)) return null;
  if (!expr.typeArguments || expr.typeArguments.length === 0) return null;
  return expr.typeArguments[0] ?? null;
}

/**
 * Build a `ts.Program` whose module resolution finds `@aharness/core`
 * and `xstate` inside the aharness install, regardless of the user's
 * directory.
 *
 * The `paths` mapping is anchored on `baseUrl: aharnessNodeModules`. Two
 * mappings cover both bare and sub-path specifiers (`@aharness/core`
 * and `@aharness/core/runtime`).
 */
function buildProgram(
  filePath: string,
  installPaths: InstallPaths,
  packageResolution: PackageResolutionContext | undefined,
): ts.Program {
  const aharnessNodeModules = path.dirname(path.dirname(installPaths.aharnessCoreSdkPackageDir));
  const baseUrl = packageResolution
    ? path.join(path.resolve(packageResolution.managedProjectRoot), 'node_modules')
    : aharnessNodeModules;
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    strict: false,
    noEmit: true,
    baseUrl,
    paths: {
      '@aharness/core': [
        packageResolution ? installPaths.aharnessCoreSdkPackageDir : '@aharness/core',
      ],
      '@aharness/core/*': [
        packageResolution
          ? path.join(installPaths.aharnessCoreSdkPackageDir, '*')
          : '@aharness/core/*',
      ],
      xstate: [packageResolution ? installPaths.xstatePackageDir : 'xstate'],
      'xstate/*': [packageResolution ? path.join(installPaths.xstatePackageDir, '*') : 'xstate/*'],
    },
  };
  return ts.createProgram({
    rootNames: [filePath],
    options: compilerOptions,
  });
}

/**
 * Resolve `typeNode` against the type checker and return the untyped
 * label if it (or its alias chain) is `any` / `unknown` / `never`.
 * `null` means the type is concrete enough to extract a schema from.
 *
 * Uses the type checker rather than `node.kind === ts.SyntaxKind.AnyKeyword`
 * so aliases like `type Foo = any` are also caught — the SDK's typed-submit
 * thesis applies to the resolved type, not the surface syntax.
 *
 * Known limit: only the *top-level* type is inspected. A nested `any`
 * (`exit<{ payload: any }>` or `exit<any[]>`) defeats the typed-submit
 * thesis just as much, but the resulting JSON Schema is `{ type: 'object' }`
 * with vacuous property schemas, which `ts-json-schema-generator` happily
 * emits and ajv happily compiles. Closing this requires walking the resolved
 * `Type` graph for `Any`/`Unknown`/`Never` flags anywhere in the tree, with
 * care for recursive types and generic parameters. Tracked as a follow-up
 * — for now, top-level rejection is the contract.
 */
function classifyUntyped(
  checker: ts.TypeChecker,
  typeNode: ts.TypeNode,
): 'any' | 'unknown' | 'never' | null {
  const t = checker.getTypeFromTypeNode(typeNode);
  if ((t.flags & ts.TypeFlags.Any) !== 0) return 'any';
  if ((t.flags & ts.TypeFlags.Unknown) !== 0) return 'unknown';
  if ((t.flags & ts.TypeFlags.Never) !== 0) return 'never';
  return null;
}

/**
 * Enforce `schema.type === "object"` with no top-level `anyOf`/`oneOf`/
 * `allOf` — the shape Anthropic's tool API accepts as `tool.input_schema`.
 *
 * `ts-json-schema-generator` emits a bare `anyOf`/`oneOf` (no top-level
 * `type`) for discriminated-union payloads. JSON Schema accepts that
 * shape, but the API responds:
 *
 *   `tools.N.custom.input_schema: input_schema does not support oneOf,
 *   allOf, or anyOf at the top level`
 *
 * even when `type: "object"` is added alongside. The author must wrap
 * such payloads in an object property — e.g. `exit<{ next: A | B }>({...})`
 * — so the union sits inside `properties`. Rejection here surfaces as
 * an `exit-payload-non-object` issue and blocks the run at verify time
 * rather than at first `tools/list`.
 *
 * Also rejects top-level primitives (`exit<string>(...)`), arrays, etc.
 * Hard rule 3 treats submit payloads as structured object data.
 */
function requireObjectInputSchema(
  schema: JSONSchema7,
): { ok: true; schema: JSONSchema7 } | { ok: false; reason: string } {
  if (schema.anyOf || schema.oneOf || schema.allOf) {
    return {
      ok: false,
      reason:
        "top-level schema is a union (anyOf/oneOf/allOf) — Anthropic's tool API rejects unions at the top level; wrap the union in an object property, e.g. `exit<{ next: A | B }>({...})`",
    };
  }
  if (schema.type === 'object') return { ok: true, schema };
  return {
    ok: false,
    reason: `top-level schema has type "${String(schema.type ?? 'unspecified')}", expected "object"`,
  };
}

function compileValidator(ajv: AjvInstance, schema: JSONSchema7): ValidateFunction | null {
  try {
    // ajv's `Schema` type is a near-superset of `JSONSchema7` but uses its
    // own `SchemaObject` declaration; cast through the narrowest accepted
    // ajv type rather than `object`.
    return ajv.compile(schema as Schema);
  } catch {
    return null;
  }
}

function makeValidate(fn: ValidateFunction): (input: unknown) => SidecarValidateResult {
  return (input: unknown): SidecarValidateResult => {
    if (fn(input)) {
      return { ok: true, data: input };
    }
    const raw = fn.errors ?? [];
    const errors: ValidationError[] = raw.map((e) => ({
      path: e.instancePath,
      message: e.message ?? 'invalid',
    }));
    return { ok: false, errors };
  };
}
