import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import type { ClearOnEntryMeta, ClearOnEntryReasoningEffort } from '../state/exits.js';
import type { RunCtx } from '../types.js';

export interface ResolveClearOnEntryOptionsOpts {
  readonly clearOnEntry: ClearOnEntryMeta;
  readonly context: Readonly<RunCtx>;
  readonly defaultCwd: string;
  readonly stateId: string;
}

export interface ClearOnEntryRuntimeOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly reasoningEffort?: ClearOnEntryReasoningEffort;
}

const clearOnEntryReasoningEfforts = new Set<ClearOnEntryReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export function resolveClearOnEntryOptions(
  opts: ResolveClearOnEntryOptionsOpts,
): ClearOnEntryRuntimeOptions {
  const { clearOnEntry, context, defaultCwd, stateId } = opts;

  if (clearOnEntry === true) {
    return { cwd: validateCwd(defaultCwd, stateId, 'default cwd for clearOnEntry') };
  }

  if (clearOnEntry === null || typeof clearOnEntry !== 'object' || Array.isArray(clearOnEntry)) {
    throw new TypeError(
      `state "${stateId}" clearOnEntry must be true or an object with at least one of cwd, model, or reasoningEffort`,
    );
  }

  const cwdValue = clearOnEntry.cwd;
  const model = clearOnEntry.model;
  const reasoningEffort = clearOnEntry.reasoningEffort;

  if (cwdValue === undefined && model === undefined && reasoningEffort === undefined) {
    throw new TypeError(
      `state "${stateId}" clearOnEntry object must include at least one supported key: cwd, model, reasoningEffort`,
    );
  }
  if (cwdValue !== undefined && typeof cwdValue !== 'string' && typeof cwdValue !== 'function') {
    throw new TypeError(`state "${stateId}" clearOnEntry.cwd must be a string or function`);
  }
  if (model !== undefined && typeof model !== 'string') {
    throw new TypeError(`state "${stateId}" clearOnEntry.model must be a string`);
  }
  if (
    reasoningEffort !== undefined &&
    (typeof reasoningEffort !== 'string' || !clearOnEntryReasoningEfforts.has(reasoningEffort))
  ) {
    throw new TypeError(
      `state "${stateId}" clearOnEntry.reasoningEffort must be one of: none, minimal, low, medium, high, xhigh`,
    );
  }

  if (typeof cwdValue === 'function') {
    let resolved: unknown;
    try {
      resolved = cwdValue(context);
    } catch (error) {
      throw new Error(
        `state "${stateId}" clearOnEntry.cwd function threw: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
    return {
      cwd: validateCwd(resolved, stateId, 'clearOnEntry.cwd'),
      ...(model !== undefined ? { model } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
  }

  return {
    cwd:
      cwdValue === undefined
        ? validateCwd(defaultCwd, stateId, 'default cwd for clearOnEntry')
        : validateCwd(cwdValue, stateId, 'clearOnEntry.cwd'),
    ...(model !== undefined ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

function validateCwd(value: unknown, stateId: string, label: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`state "${stateId}" ${label} must resolve to a string`);
  }
  if (value.length === 0) {
    throw new TypeError(`state "${stateId}" ${label} must be a non-empty absolute path`);
  }
  if (!isAbsolute(value)) {
    throw new TypeError(`state "${stateId}" ${label} must be an absolute path: ${value}`);
  }

  let stats;
  try {
    stats = statSync(value);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') {
      throw new Error(`state "${stateId}" ${label} does not exist: ${value}`, { cause: error });
    }
    throw new Error(
      `state "${stateId}" ${label} could not be inspected: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }

  if (!stats.isDirectory()) {
    throw new TypeError(`state "${stateId}" ${label} must be a directory: ${value}`);
  }

  return value;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
