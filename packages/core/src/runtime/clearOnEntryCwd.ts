import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import type { ClearOnEntryMeta, StateModelEffort, StateModelMeta } from '../state/exits.js';
import type { RunCtx } from '../types.js';

export interface ResolveClearOnEntryOptionsOpts {
  readonly clearOnEntry: ClearOnEntryMeta;
  readonly context: Readonly<RunCtx>;
  readonly defaultCwd: string;
  readonly stateId: string;
}

export interface ClearOnEntryRuntimeOptions {
  readonly cwd: string;
}

export interface StateModelRuntimeOptions {
  readonly model?: string;
  readonly effort?: StateModelEffort;
}

export function resolveStateModelOptions(model?: StateModelMeta): StateModelRuntimeOptions {
  if (model === undefined) return {};
  return {
    ...(model.name !== undefined ? { model: model.name } : {}),
    ...(model.effort !== undefined ? { effort: model.effort } : {}),
  };
}

export function resolveClearOnEntryOptions(
  opts: ResolveClearOnEntryOptionsOpts,
): ClearOnEntryRuntimeOptions {
  const { clearOnEntry, context, defaultCwd, stateId } = opts;

  if (clearOnEntry === true) {
    return { cwd: validateCwd(defaultCwd, stateId, 'default cwd for clearOnEntry') };
  }

  if (clearOnEntry === null || typeof clearOnEntry !== 'object' || Array.isArray(clearOnEntry)) {
    throw new TypeError(
      `state "${stateId}" clearOnEntry must be true or an object with at least one of cwd`,
    );
  }

  const cwdValue = clearOnEntry.cwd;

  if (cwdValue === undefined) {
    throw new TypeError(
      `state "${stateId}" clearOnEntry object must include at least one supported key: cwd`,
    );
  }
  if (cwdValue !== undefined && typeof cwdValue !== 'string' && typeof cwdValue !== 'function') {
    throw new TypeError(`state "${stateId}" clearOnEntry.cwd must be a string or function`);
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
    };
  }

  return {
    cwd:
      cwdValue === undefined
        ? validateCwd(defaultCwd, stateId, 'default cwd for clearOnEntry')
        : validateCwd(cwdValue, stateId, 'clearOnEntry.cwd'),
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
