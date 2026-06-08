import { isAbsolute, resolve } from 'node:path';
import type { AnyStateMachine } from 'xstate';

import type { SkillOriginManifest } from '../loader/cache.js';
import { getAharnessMeta, iterStates, stateKeyPath } from '../state.js';
import { isSkillRef, skillKey, type SkillRefPath, type SkillRef } from './skills.js';

export interface SkillOriginEnv {
  readonly rootSourceDir: string;
  readonly sourceDirPrefixes: readonly {
    readonly stateIdPrefix: string;
    readonly sourceDir: string;
  }[];
  readonly threadSkills: readonly {
    readonly sourceDir: string;
    readonly key: string;
    readonly ref: SkillRef;
  }[];
}

export function skillOriginEnvFromManifest(manifest: SkillOriginManifest): SkillOriginEnv {
  return {
    rootSourceDir: manifest.rootSourceDir,
    sourceDirPrefixes: manifest.sourceDirPrefixes,
    threadSkills: manifest.threadSkills ?? [],
  };
}

export function sourceDirForState(stateId: string, env: SkillOriginEnv): string {
  let best: { prefix: string; sourceDir: string } | undefined;
  for (const entry of env.sourceDirPrefixes) {
    if (!stateIdMatchesPrefix(stateId, entry.stateIdPrefix)) continue;
    if (best === undefined || entry.stateIdPrefix.length > best.prefix.length) {
      best = { prefix: entry.stateIdPrefix, sourceDir: entry.sourceDir };
    }
  }
  return best?.sourceDir ?? env.rootSourceDir;
}

export function stateIdMatchesPrefix(stateId: string, prefix: string): boolean {
  return stateId === prefix || stateId.startsWith(`${prefix}.`);
}

export function resolveSkillPathFromSource(ref: SkillRefPath, sourceDir: string): string {
  return isAbsolute(ref.path) ? resolve(ref.path) : resolve(sourceDir, ref.path);
}

export interface StateSkillRefWithOrigin {
  readonly stateId: string;
  readonly index: number;
  readonly ref: SkillRef;
  readonly sourceDir: string;
}

export interface ThreadSkillRefWithOrigin {
  readonly key: string;
  readonly ref: SkillRef;
  readonly sourceDir: string;
}

export function collectStateSkillsWithOrigins(
  machine: AnyStateMachine,
  env: SkillOriginEnv,
): StateSkillRefWithOrigin[] {
  const out: StateSkillRefWithOrigin[] = [];
  for (const node of iterStates(machine)) {
    const meta = getAharnessMeta(node);
    if (meta?.kind !== 'stateful' || meta.skills === undefined) continue;
    const stateId = stateKeyPath(node);
    const sourceDir = sourceDirForState(stateId, env);
    for (let index = 0; index < meta.skills.length; index += 1) {
      const ref = meta.skills[index];
      if (ref === undefined) continue;
      out.push({ stateId, index, ref, sourceDir });
    }
  }
  return out;
}

export function collectThreadSkillsWithOrigins(
  machine: AnyStateMachine,
  env: SkillOriginEnv,
): ThreadSkillRefWithOrigin[] {
  const out: ThreadSkillRefWithOrigin[] = env.threadSkills.map((entry) => ({
    key: entry.key,
    ref: entry.ref,
    sourceDir: entry.sourceDir,
  }));
  const seen = new Set(out.map(threadSkillOriginKey));
  const raw = rawThreadSkills(machine);
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return out;
  }
  for (const [key, ref] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSkillRef(ref)) continue;
    const entry = { key, ref, sourceDir: env.rootSourceDir };
    const originKey = threadSkillOriginKey(entry);
    if (seen.has(originKey)) continue;
    seen.add(originKey);
    out.push(entry);
  }
  return out;
}

type RawThreadSkillsMachine = {
  readonly __aharnessRawConfig?: {
    readonly threadSkills?: unknown;
  };
};

function rawThreadSkills(machine: AnyStateMachine): unknown {
  return (machine as RawThreadSkillsMachine).__aharnessRawConfig?.threadSkills;
}

function threadSkillOriginKey(entry: ThreadSkillRefWithOrigin): string {
  return `${entry.sourceDir}\0${entry.key}\0${skillRefOriginKey(entry.ref)}`;
}

function skillRefOriginKey(ref: SkillRef): string {
  return `${skillKey(ref)}:${ref.optional ? 'optional' : 'required'}`;
}
