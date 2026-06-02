import type { UserInput, UserInputSkill } from '../protocol/types.js';
import type { SkillRef } from '../state/skills.js';

import type { ResolvedRuntimeSkill } from './skillCatalog.js';

export interface SelectStateSkillInputOpts {
  readonly stateId: string;
  readonly skills: ReadonlyArray<SkillRef>;
  readonly resolvedSkills: ReadonlyArray<ResolvedRuntimeSkill>;
  readonly alreadyInjected: ReadonlySet<string>;
}

export interface SelectedStateSkillInput {
  readonly skillItems: ReadonlyArray<UserInputSkill>;
  readonly pendingKeys: ReadonlyArray<string>;
  readonly commit: () => void;
}

export interface BuildStateOrientationInputOpts {
  readonly stateId: string;
  readonly skills?: ReadonlyArray<SkillRef>;
  readonly orientationText: string;
}

export interface BuiltStateOrientationInput {
  readonly text: string;
  readonly input: ReadonlyArray<UserInput>;
  readonly commit: () => void;
}

export interface StateSkillInjectionService {
  readonly buildTurnInputForActive: (
    opts: BuildStateOrientationInputOpts,
  ) => BuiltStateOrientationInput;
  readonly resetForFreshThread: () => void;
}

export function selectStateSkillInput(opts: SelectStateSkillInputOpts): SelectedStateSkillInput {
  const byStateAndIndex = new Map<string, ResolvedRuntimeSkill>();
  for (const resolved of opts.resolvedSkills) {
    byStateAndIndex.set(selectionKey(resolved.stateId, resolved.index), resolved);
  }

  const localPending = new Set<string>();
  const skillItems: UserInputSkill[] = [];
  const pendingKeys: string[] = [];
  opts.skills.forEach((ref, index) => {
    const resolved = byStateAndIndex.get(selectionKey(opts.stateId, index));
    if (resolved === undefined) {
      if (ref.optional) return;
      throw new Error(
        `internal: required skill for state '${opts.stateId}' skills[${String(index)}] was not resolved by startup preflight`,
      );
    }

    const key = injectedKey(resolved);
    if (opts.alreadyInjected.has(key) || localPending.has(key)) return;
    localPending.add(key);
    pendingKeys.push(key);
    skillItems.push({
      type: 'skill',
      name: resolved.name,
      path: resolved.path,
    });
  });

  return {
    skillItems,
    pendingKeys,
    commit: () => {
      if (!isMutableSet(opts.alreadyInjected)) {
        throw new Error('internal: alreadyInjected must be a Set to commit selected skills');
      }
      for (const key of pendingKeys) opts.alreadyInjected.add(key);
    },
  };
}

export function createStateSkillInjectionService(input: {
  readonly resolvedSkills: ReadonlyArray<ResolvedRuntimeSkill>;
}): StateSkillInjectionService {
  const injected = new Set<string>();
  return {
    buildTurnInputForActive(opts) {
      const selected =
        opts.skills === undefined || opts.skills.length === 0
          ? { skillItems: [], commit: () => undefined }
          : selectStateSkillInput({
              stateId: opts.stateId,
              skills: opts.skills,
              resolvedSkills: input.resolvedSkills,
              alreadyInjected: injected,
            });
      return {
        text: opts.orientationText,
        input: [{ type: 'text', text: opts.orientationText }, ...selected.skillItems],
        commit: selected.commit,
      };
    },
    resetForFreshThread() {
      injected.clear();
    },
  };
}

function selectionKey(stateId: string, index: number): string {
  return `${stateId}\0${String(index)}`;
}

function injectedKey(skill: ResolvedRuntimeSkill): string {
  return `path:${skill.path}`;
}

function isMutableSet(value: ReadonlySet<string>): value is Set<string> {
  return typeof (value as Set<string>).add === 'function';
}
