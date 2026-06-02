import { dirname, isAbsolute, resolve } from 'node:path';
import type { AnyStateMachine } from 'xstate';

import type { SkillOriginManifest } from '../loader/cache.js';
import type { SkillCatalogError, SkillsListResponse } from '../protocol/index.js';
import {
  collectStateSkillsWithOrigins,
  resolveSkillPathFromSource,
  skillOriginEnvFromManifest,
} from '../state/skillOrigins.js';
import type { SkillRef } from '../state/skills.js';

export interface SkillCatalogPreflightInput {
  readonly machine: AnyStateMachine;
  readonly skillOriginManifest: SkillOriginManifest;
}

export interface RuntimeSkillRequirement {
  readonly stateId: string;
  readonly index: number;
  readonly ref: SkillRef;
  readonly optional: boolean;
  readonly displayName: string;
  readonly resolvedPath?: string;
}

export interface SkillCatalogPreflight {
  readonly extraRoots: readonly string[];
  readonly requirements: readonly RuntimeSkillRequirement[];
}

export interface ResolvedRuntimeSkill {
  readonly stateId: string;
  readonly index: number;
  readonly name: string;
  readonly path: string;
}

export interface SkillCatalogValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly resolvedSkills: readonly ResolvedRuntimeSkill[];
}

export function isSkillsListResponse(value: unknown): value is SkillsListResponse {
  if (value === null || typeof value !== 'object') return false;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return false;
  return data.every(isSkillsListEntry);
}

export function buildSkillCatalogPreflight(
  input: SkillCatalogPreflightInput,
): SkillCatalogPreflight {
  const roots = new Set<string>();
  for (const available of input.skillOriginManifest.availableSkills) {
    if (available.ref.source === 'dir') {
      roots.add(resolveFromSource(available.ref.path, available.sourceDir));
      continue;
    }
    const absPath = resolveFromSource(available.ref.path, available.sourceDir);
    roots.add(dirname(absPath));
  }

  const originEnv = skillOriginEnvFromManifest(input.skillOriginManifest);
  const requirements: RuntimeSkillRequirement[] = [];
  for (const stateSkill of collectStateSkillsWithOrigins(input.machine, originEnv)) {
    const ref = stateSkill.ref;
    if (ref.source === 'path') {
      const resolvedPath = resolveSkillPathFromSource(ref, stateSkill.sourceDir);
      roots.add(dirname(resolvedPath));
      requirements.push({
        stateId: stateSkill.stateId,
        index: stateSkill.index,
        ref,
        optional: ref.optional,
        displayName: ref.path,
        resolvedPath,
      });
      continue;
    }
    requirements.push({
      stateId: stateSkill.stateId,
      index: stateSkill.index,
      ref,
      optional: ref.optional,
      displayName: ref.name,
    });
  }

  return {
    extraRoots: [...roots].sort(),
    requirements,
  };
}

export function validateSkillCatalog(input: {
  readonly response: SkillsListResponse;
  readonly repoRoot: string;
  readonly preflight: SkillCatalogPreflight;
}): SkillCatalogValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const entries = input.response.data;
  if (entries.length !== 1) {
    return {
      ok: false,
      errors: [
        `skills/list returned ${String(entries.length)} entries for cwd '${input.repoRoot}', expected exactly one`,
      ],
      warnings,
      resolvedSkills: [],
    };
  }
  const entry = entries[0];
  if (entry === undefined) {
    return {
      ok: false,
      errors: [`skills/list returned no entry for cwd '${input.repoRoot}'`],
      warnings,
      resolvedSkills: [],
    };
  }
  if (normalizeAbs(entry.cwd) !== normalizeAbs(input.repoRoot)) {
    errors.push(
      `skills/list returned cwd '${entry.cwd}', expected '${normalizeAbs(input.repoRoot)}'`,
    );
  }
  for (const error of entry.errors) {
    errors.push(formatCatalogError(error));
  }

  const enabled = entry.skills.filter((skill) => skill.enabled);
  const resolvedSkills: ResolvedRuntimeSkill[] = [];
  for (const need of input.preflight.requirements) {
    if (need.ref.source === 'path') {
      const requiredPath = need.resolvedPath;
      if (requiredPath === undefined) continue;
      const matches = enabled.filter((skill) => normalizeAbs(skill.path) === requiredPath);
      if (matches.length === 1) {
        const match = matches[0]!;
        resolvedSkills.push({
          stateId: need.stateId,
          index: need.index,
          name: match.name,
          path: normalizeAbs(match.path),
        });
        continue;
      }
      const message =
        matches.length === 0
          ? `state '${need.stateId}' skills[${String(need.index)}] path '${need.displayName}' resolved to '${requiredPath}' is missing from enabled Codex skills`
          : `state '${need.stateId}' skills[${String(need.index)}] path '${need.displayName}' resolved to '${requiredPath}' matched ${String(matches.length)} enabled Codex skills`;
      pushDiagnostic({ optional: need.optional, message, errors, warnings });
      continue;
    }

    if (need.ref.source !== 'name') continue;
    const requiredName = need.ref.name;
    const matches = enabled.filter((skill) => skill.name === requiredName);
    if (matches.length === 1) {
      const match = matches[0]!;
      resolvedSkills.push({
        stateId: need.stateId,
        index: need.index,
        name: match.name,
        path: normalizeAbs(match.path),
      });
      continue;
    }
    const message =
      matches.length === 0
        ? `state '${need.stateId}' skills[${String(need.index)}] name '${requiredName}' is missing from enabled Codex skills`
        : `state '${need.stateId}' skills[${String(need.index)}] name '${requiredName}' matched ${String(matches.length)} enabled Codex skills`;
    pushDiagnostic({ optional: need.optional, message, errors, warnings });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    resolvedSkills,
  };
}

function resolveFromSource(refPath: string, sourceDir: string): string {
  return isAbsolute(refPath) ? resolve(refPath) : resolve(sourceDir, refPath);
}

function normalizeAbs(p: string): string {
  return resolve(p);
}

function formatCatalogError(error: SkillCatalogError): string {
  return `skills/list catalog error at '${error.path}': ${error.message}`;
}

function pushDiagnostic(input: {
  readonly optional: boolean;
  readonly message: string;
  readonly errors: string[];
  readonly warnings: string[];
}): void {
  if (input.optional) {
    input.warnings.push(input.message);
  } else {
    input.errors.push(input.message);
  }
}

function isSkillsListEntry(value: unknown): value is SkillsListResponse['data'][number] {
  if (value === null || typeof value !== 'object') return false;
  const record = value as { cwd?: unknown; skills?: unknown; errors?: unknown };
  return (
    typeof record.cwd === 'string' &&
    Array.isArray(record.skills) &&
    record.skills.every(isSkillCatalogEntry) &&
    Array.isArray(record.errors) &&
    record.errors.every(isSkillCatalogError)
  );
}

function isSkillCatalogEntry(
  value: unknown,
): value is SkillsListResponse['data'][number]['skills'][number] {
  if (value === null || typeof value !== 'object') return false;
  const record = value as { name?: unknown; path?: unknown; enabled?: unknown };
  return (
    typeof record.name === 'string' &&
    typeof record.path === 'string' &&
    typeof record.enabled === 'boolean'
  );
}

function isSkillCatalogError(value: unknown): value is SkillCatalogError {
  if (value === null || typeof value !== 'object') return false;
  const record = value as { path?: unknown; message?: unknown };
  return typeof record.path === 'string' && typeof record.message === 'string';
}
