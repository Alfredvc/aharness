import type {
  CanonicalAwaitMeta,
  CanonicalEventBranchMeta,
  CanonicalEventMeta,
  CanonicalSubmitBranchMeta,
  CanonicalSubmitMeta,
} from './exits.js';
import type { CanonicalEmbeddedFinalHandler } from './embed.js';
import { createAharnessOps, type AharnessOps } from './aharnessOps.js';

export const CANONICAL_COMMIT_CONTEXT_KEY = '__aharnessCanonicalCommitContext';
export const CANONICAL_SELECTED_BRANCH_KEY = '__aharnessCanonicalSelectedBranch';
export const CANONICAL_EMBEDDED_FINAL_COMMIT_CONTEXT_KEY =
  '__aharnessCanonicalEmbeddedFinalCommitContext';

let dryRunDepth = 0;

export function withCanonicalDryRun<T>(fn: () => T): T {
  dryRunDepth++;
  try {
    return fn();
  } finally {
    dryRunDepth--;
  }
}

export function isCanonicalDryRun(): boolean {
  return dryRunDepth > 0;
}

const noopOps: AharnessOps = createAharnessOps().ops;

export function defaultCanonicalOps(): AharnessOps {
  return noopOps;
}

export function cloneCanonicalCallbackData<T>(data: T): T {
  return cloneValue(data);
}

export function canonicalCommitContext(event: unknown): Record<string, unknown> | undefined {
  const payload = (event as { payload?: unknown } | undefined)?.payload;
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[CANONICAL_COMMIT_CONTEXT_KEY];
  if (value !== null && typeof value === 'object') return value as Record<string, unknown>;
  return undefined;
}

export function canonicalSelectedBranchIndex(event: unknown): number | undefined {
  const payload = (event as { payload?: unknown } | undefined)?.payload;
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[CANONICAL_SELECTED_BRANCH_KEY];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function canonicalEmbeddedFinalCommitContext(
  event: unknown,
): Record<string, unknown> | undefined {
  const payload = (event as { payload?: unknown } | undefined)?.payload;
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[CANONICAL_EMBEDDED_FINAL_COMMIT_CONTEXT_KEY];
  if (value !== null && typeof value === 'object') return value as Record<string, unknown>;
  return undefined;
}

export function payloadWithoutCanonicalCommit<T>(payload: T): T {
  if (payload === null || typeof payload !== 'object') return payload;
  const record = payload as Record<string, unknown>;
  if (
    !(CANONICAL_COMMIT_CONTEXT_KEY in record) &&
    !(CANONICAL_SELECTED_BRANCH_KEY in record) &&
    !(CANONICAL_EMBEDDED_FINAL_COMMIT_CONTEXT_KEY in record)
  ) {
    return payload;
  }
  const clone = { ...(payload as Record<string, unknown>) };
  delete clone[CANONICAL_COMMIT_CONTEXT_KEY];
  delete clone[CANONICAL_SELECTED_BRANCH_KEY];
  delete clone[CANONICAL_EMBEDDED_FINAL_COMMIT_CONTEXT_KEY];
  return clone as T;
}

export function payloadWithCanonicalSelectedBranch(payload: unknown, branchIndex: number): unknown {
  return payloadWithCanonicalMeta(payload, {
    [CANONICAL_SELECTED_BRANCH_KEY]: branchIndex,
  });
}

export function payloadWithCanonicalCommit(
  payload: unknown,
  nextContext: Record<string, unknown>,
  branchIndex?: number,
): unknown {
  return payloadWithCanonicalMeta(payload, {
    [CANONICAL_COMMIT_CONTEXT_KEY]: nextContext,
    ...(branchIndex !== undefined ? { [CANONICAL_SELECTED_BRANCH_KEY]: branchIndex } : {}),
  });
}

export function payloadWithCanonicalEmbeddedFinalCommit(
  payload: unknown,
  nextContext: Record<string, unknown>,
): unknown {
  return payloadWithCanonicalMeta(payload, {
    [CANONICAL_EMBEDDED_FINAL_COMMIT_CONTEXT_KEY]: nextContext,
  });
}

function payloadWithCanonicalMeta(payload: unknown, meta: Record<string, unknown>): unknown {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      ...(payload as Record<string, unknown>),
      ...meta,
    };
  }
  return {
    value: payload,
    ...meta,
  };
}

export function applyCanonicalCommitOrReduce<TPayload>(args: {
  readonly context: Record<string, unknown>;
  readonly event: unknown;
  readonly branch: CanonicalSubmitBranchMeta<Record<string, unknown>, TPayload>;
  readonly payload: TPayload;
}): Record<string, unknown> {
  const precomputed = canonicalCommitContext(args.event);
  if (precomputed !== undefined) return precomputed;
  if (args.branch.reduce === undefined) return args.context;
  return reduceContext(args.context, (draft) => args.branch.reduce?.(draft, args.payload));
}

export function applyCanonicalAwaitCommitOrReduce(args: {
  readonly context: Record<string, unknown>;
  readonly event: unknown;
  readonly meta: CanonicalAwaitMeta<Record<string, unknown>>;
  readonly ownerReply: string;
}): Record<string, unknown> {
  const precomputed = canonicalCommitContext(args.event);
  if (precomputed !== undefined) return precomputed;
  if (args.meta.reduce === undefined) return args.context;
  return reduceContext(args.context, (draft) => args.meta.reduce?.(draft, args.ownerReply));
}

export async function prepareCanonicalSubmitCommit(args: {
  readonly meta: CanonicalSubmitMeta<Record<string, unknown>, unknown>;
  readonly branchIndex: number;
  readonly context: Record<string, unknown>;
  readonly payload: unknown;
  readonly ops?: AharnessOps;
}): Promise<
  | { readonly ok: true; readonly nextContext: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }
> {
  const branch = args.meta.branches[args.branchIndex];
  if (!branch) return { ok: false, error: `canonical submit branch ${args.branchIndex} missing` };
  try {
    if (branch.effect !== undefined) {
      await branch.effect({
        data: cloneCanonicalCallbackData(args.context),
        payload: args.payload,
        ops: args.ops ?? defaultCanonicalOps(),
      });
    }
    const nextContext =
      branch.reduce === undefined
        ? args.context
        : reduceContext(args.context, (draft) => branch.reduce?.(draft, args.payload));
    return { ok: true, nextContext };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function prepareCanonicalAwaitCommit(args: {
  readonly meta: CanonicalAwaitMeta<Record<string, unknown>>;
  readonly context: Record<string, unknown>;
  readonly ownerReply: string;
  readonly ops?: AharnessOps;
}): Promise<
  | { readonly ok: true; readonly nextContext: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }
> {
  try {
    if (args.meta.effect !== undefined) {
      await args.meta.effect({
        data: cloneCanonicalCallbackData(args.context),
        ownerReply: args.ownerReply,
        ops: args.ops ?? defaultCanonicalOps(),
      });
    }
    const nextContext =
      args.meta.reduce === undefined
        ? args.context
        : reduceContext(args.context, (draft) => args.meta.reduce?.(draft, args.ownerReply));
    return { ok: true, nextContext };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function prepareCanonicalEventCommit(args: {
  readonly meta: CanonicalEventMeta<Record<string, unknown>, unknown, unknown>;
  readonly branchIndex: number;
  readonly context: Record<string, unknown>;
  readonly payload: unknown;
  readonly ops?: AharnessOps;
}): Promise<
  | { readonly ok: true; readonly nextContext: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }
> {
  const branch = args.meta.branches[args.branchIndex];
  if (!branch) return { ok: false, error: `canonical event branch ${args.branchIndex} missing` };
  try {
    if (branch.effect !== undefined) {
      await branch.effect({
        data: cloneCanonicalCallbackData(args.context),
        payload: args.payload,
        ops: args.ops ?? defaultCanonicalOps(),
      });
    }
    const nextContext =
      branch.reduce === undefined
        ? args.context
        : reduceContext(args.context, (draft) => branch.reduce?.(draft, args.payload));
    return { ok: true, nextContext };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function prepareCanonicalEmbeddedFinalCommit(args: {
  readonly handler: CanonicalEmbeddedFinalHandler;
  readonly context: Record<string, unknown>;
  readonly output: unknown;
  readonly ops?: AharnessOps;
}): Promise<
  | { readonly ok: true; readonly nextContext: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }
> {
  try {
    const effect = args.handler.effect as
      | ((input: {
          readonly data: Readonly<Record<string, unknown>>;
          readonly output: unknown;
          readonly ops: AharnessOps;
        }) => void | Promise<void>)
      | undefined;
    if (effect !== undefined) {
      await effect({
        data: cloneCanonicalCallbackData(args.context),
        output: args.output,
        ops: args.ops ?? defaultCanonicalOps(),
      });
    }
    const reduce = args.handler.reduce as
      | ((
          draft: Record<string, unknown>,
          output: unknown,
        ) => void | Partial<Record<string, unknown>>)
      | undefined;
    const nextContext =
      reduce === undefined
        ? args.context
        : reduceContext(args.context, (draft) => reduce(draft, args.output));
    return { ok: true, nextContext };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function runCanonicalEventReturn(args: {
  readonly branch: CanonicalEventBranchMeta<Record<string, unknown>, unknown, unknown>;
  readonly context: Record<string, unknown>;
  readonly payload: unknown;
}):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string } {
  if (args.branch.return === undefined) return { ok: true, value: undefined };
  try {
    return {
      ok: true,
      value: args.branch.return(cloneCanonicalCallbackData(args.context), args.payload),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function runCanonicalEffectSynchronously(args: {
  readonly run: () => void | Promise<void>;
}): boolean {
  if (isCanonicalDryRun()) return true;
  try {
    const result = args.run();
    if (isPromiseLike(result)) {
      const state = inspectPromiseState(result);
      if (state === 'rejected') {
        result.catch(() => undefined);
        return false;
      }
      if (state === 'pending') {
        result.catch(() => undefined);
        return false;
      }
      result.catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
}

function reduceContext(
  context: Record<string, unknown>,
  reduce: (draft: Record<string, unknown>) => void | Partial<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const draft = cloneContext(context);
  const result = reduce(draft);
  if (result !== undefined && result !== null && typeof result === 'object') {
    Object.assign(draft, result);
  }
  return draft;
}

function cloneContext(context: Record<string, unknown>): Record<string, unknown> {
  return cloneValue(context);
}

function cloneValue<T>(value: T, seen = new Map<object, unknown>()): T {
  try {
    return structuredClone(value);
  } catch {
    return cloneValueFallback(value, seen);
  }
}

function cloneValueFallback<T>(value: T, seen: Map<object, unknown>): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value) as T;

  if (value instanceof Date) return new Date(value.getTime()) as T;

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(cloneValueFallback(item, seen));
    return clone as T;
  }

  const source = value as object;
  const prototype = Object.getPrototypeOf(source) as object | null;
  const clone = Object.create(prototype) as Record<PropertyKey, unknown>;
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    let nextDescriptor = descriptor;
    if ('value' in descriptor) {
      nextDescriptor = {
        ...descriptor,
        value: cloneValueFallback(descriptor.value as unknown, seen),
      };
    }
    Object.defineProperty(clone, key, nextDescriptor);
  }
  return clone as T;
}

function isPromiseLike(value: unknown): value is Promise<void> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function' &&
    typeof (value as { catch?: unknown }).catch === 'function'
  );
}

function inspectPromiseState(promise: Promise<void>): 'fulfilled' | 'rejected' | 'pending' | null {
  const processLike = (
    globalThis as {
      process?: {
        getBuiltinModule?: (name: string) => { inspect?: (value: unknown) => string } | undefined;
      };
    }
  ).process;
  const inspect = processLike?.getBuiltinModule?.('node:util')?.inspect;
  if (inspect === undefined) return null;
  const text = inspect(promise);
  if (text.includes('<rejected>')) return 'rejected';
  if (text.includes('<pending>')) return 'pending';
  if (text.startsWith('Promise {')) return 'fulfilled';
  return null;
}
