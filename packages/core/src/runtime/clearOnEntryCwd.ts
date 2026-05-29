import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import type { ClearOnEntryMeta } from '../state/exits.js';
import type { RunCtx } from '../types.js';

export interface ResolveClearOnEntryCwdOpts {
  readonly clearOnEntry: ClearOnEntryMeta;
  readonly context: Readonly<RunCtx>;
  readonly defaultCwd: string;
  readonly stateId: string;
}

export function resolveClearOnEntryCwd(opts: ResolveClearOnEntryCwdOpts): string {
  const { clearOnEntry, context, defaultCwd, stateId } = opts;

  if (clearOnEntry === true) {
    return validateCwd(defaultCwd, stateId, 'default cwd for clearOnEntry');
  }

  if (clearOnEntry === null || typeof clearOnEntry !== 'object' || Array.isArray(clearOnEntry)) {
    throw new TypeError(
      `state "${stateId}" clearOnEntry must be true or an object with clearOnEntry.cwd`,
    );
  }

  if (!('cwd' in clearOnEntry)) {
    throw new TypeError(`state "${stateId}" clearOnEntry.cwd is required`);
  }

  const cwdValue = clearOnEntry.cwd;
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
    return validateCwd(resolved, stateId, 'clearOnEntry.cwd');
  }

  return validateCwd(cwdValue, stateId, 'clearOnEntry.cwd');
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
