import type { AnyStateMachine, StateNode } from 'xstate';
import { getAharnessMeta, iterStates, stateKeyPath } from '../state.js';
import type { EmbeddedMeta } from '../state/embed.js';
import type { DefaultedExitDef, AharnessStateMeta } from '../state/exits.js';
import type { SkillRef } from '../state/skills.js';
import type { ChoiceMeta, SchemaSidecar } from '../types.js';
import type {
  ExitDetail,
  HookDetail,
  SkillDetail,
  TextDetail,
  Topology,
  VizEdge,
  VizNode,
} from './events.js';

type LiveDefaultedExitDef = Extract<DefaultedExitDef, { readonly __aharnessPayloadMarker: true }>;

interface MachineRootShape {
  readonly id: string;
  readonly initial?: { target?: ReadonlyArray<{ key?: string }> };
}

interface EmbedHostInfo {
  readonly path: string;
  readonly parentPrefix: string;
  readonly entry: string;
  readonly meta: EmbeddedMeta;
}

function readEmbeddedMeta(node: StateNode): EmbeddedMeta | undefined {
  const raw: unknown = node.config.meta;
  if (!raw || typeof raw !== 'object') return undefined;
  const aharness = (raw as { aharness?: unknown }).aharness;
  if (!aharness || typeof aharness !== 'object') return undefined;
  const embedded = (aharness as { embedded?: unknown }).embedded;
  if (!embedded || typeof embedded !== 'object') return undefined;
  return embedded as EmbeddedMeta;
}

function extractAlwaysEdges(
  node: StateNode,
  path: string,
  resolveTarget: (rawTo: string, sourcePath: string) => string,
): VizEdge[] {
  const raw = (node.config as { always?: unknown }).always;
  if (raw === undefined || raw === null) return [];

  type Branch = { target?: unknown };
  const branches: Branch[] = Array.isArray(raw)
    ? (raw.filter((b) => b !== null && typeof b === 'object') as Branch[])
    : typeof raw === 'string'
      ? [{ target: raw }]
      : typeof raw === 'object'
        ? [raw]
        : [];

  const out: VizEdge[] = [];
  const total = branches.filter((b) => typeof b.target === 'string' && b.target.length > 0).length;
  let i = 0;
  for (const branch of branches) {
    const target = branch.target;
    if (typeof target !== 'string' || target.length === 0) continue;
    const multi = total > 1;
    out.push({
      id: `${path}::always${multi ? '#' + String(i) : ''}`,
      from: path,
      to: resolveTarget(target, path),
      exit: 'always',
      kind: 'always',
      ...(multi ? { branchIndex: i, branchTotal: total } : {}),
    });
    i += 1;
  }
  return out;
}

function extractInvokeDoneEdges(
  node: StateNode,
  path: string,
  resolveTarget: (rawTo: string, sourcePath: string) => string,
): VizEdge[] {
  const raw = (node.config as { invoke?: unknown }).invoke;
  if (raw === undefined || raw === null) return [];

  type InvokeShape = { onDone?: unknown };
  type DoneShape = { target?: unknown };
  const invokes: InvokeShape[] = Array.isArray(raw)
    ? (raw.filter((i) => i !== null && typeof i === 'object') as InvokeShape[])
    : typeof raw === 'object'
      ? [raw]
      : [];

  const doneBranches: DoneShape[] = [];
  for (const invoke of invokes) {
    const onDone = invoke.onDone;
    if (typeof onDone === 'string') {
      doneBranches.push({ target: onDone });
    } else if (Array.isArray(onDone)) {
      doneBranches.push(
        ...(onDone.filter((b) => b !== null && typeof b === 'object') as DoneShape[]),
      );
    } else if (onDone !== null && typeof onDone === 'object') {
      doneBranches.push(onDone);
    }
  }

  const targets = doneBranches.filter(
    (branch): branch is { target: string } =>
      typeof branch.target === 'string' && branch.target.length > 0,
  );
  const multi = targets.length > 1;
  return targets.map((branch, i) => ({
    id: `${path}::done${multi ? '#' + String(i) : ''}`,
    from: path,
    to: resolveTarget(branch.target, path),
    exit: 'done',
    kind: 'always',
    ...(multi ? { branchIndex: i, branchTotal: targets.length } : {}),
  }));
}

export interface ExtractUiTopologyOptions {
  readonly sidecar?: SchemaSidecar;
}

export function extractUiTopology(
  machine: AnyStateMachine,
  options: ExtractUiTopologyOptions = {},
): Topology {
  const nodes: VizNode[] = [];
  const edges: VizEdge[] = [];
  const embedHosts = new Map<string, EmbedHostInfo>();
  const parentPathOf = new Map<string, string>();

  for (const node of iterStates(machine)) {
    const path = stateKeyPath(node);
    if (path === '') continue;
    const parentPath = node.parent ? stateKeyPath(node.parent) : '';
    parentPathOf.set(path, parentPath);
    const embedded = readEmbeddedMeta(node);
    if (!embedded) continue;
    const segs = path.split('.');
    const parentPrefix = segs.length > 1 ? `${segs.slice(0, -1).join('.')}.` : '';
    const initial = node.config.initial;
    const initialKey = typeof initial === 'string' ? initial : '';
    embedHosts.set(path, {
      path,
      parentPrefix,
      entry: initialKey ? `${path}.${initialKey}` : path,
      meta: embedded,
    });
  }

  const resolveTarget = (rawTo: string, sourcePath: string): string => {
    const sourceParent = parentPathOf.get(sourcePath) ?? '';
    const candidate = sourceParent ? `${sourceParent}.${rawTo}` : rawTo;
    return embedHosts.get(candidate)?.entry ?? candidate;
  };

  const enclosingHost = (path: string): string | undefined => {
    let p = parentPathOf.get(path);
    while (p && p !== '') {
      if (embedHosts.has(p)) return p;
      p = parentPathOf.get(p);
    }
    return undefined;
  };

  for (const host of embedHosts.values()) {
    const parent = enclosingHost(host.path);
    nodes.push({
      id: host.path,
      label: host.meta.source,
      kind: 'embed',
      entry: host.entry,
      ...(parent !== undefined ? { parent } : {}),
    });
  }

  for (const node of iterStates(machine)) {
    const path = stateKeyPath(node);
    if (path === '' || embedHosts.has(path)) continue;
    const meta = getAharnessMeta(node);
    if (!meta) continue;
    const parent = enclosingHost(path);
    const parentField = parent !== undefined ? { parent } : {};

    if (meta.kind === 'stateful') {
      const promptStr = inspectableText(meta.entryPrompt, '<dynamic prompt>');
      nodes.push({
        id: path,
        label: path,
        kind: 'stateful',
        open: meta.open,
        ...(meta.main === true ? { main: true } : {}),
        entryPrompt: promptStr.length > 240 ? `${promptStr.slice(0, 240)}...` : promptStr,
        detail: describeStatefulNode(meta, path, resolveTarget, options.sidecar),
        ...parentField,
      });
      for (const [exitName, exitDef] of Object.entries(meta.exits)) {
        if (!exitDef) continue;
        const liveExitDef = exitDef as DefaultedExitDef;
        if (!isLiveDefaultedExit(liveExitDef)) continue;
        if ('to' in liveExitDef) {
          edges.push({
            id: `${path}::${exitName}`,
            from: path,
            to: resolveTarget(liveExitDef.to, path),
            exit: exitName,
            kind: 'submit',
            ...(liveExitDef.description !== undefined
              ? { description: liveExitDef.description }
              : {}),
          });
        } else {
          const total = liveExitDef.when.length;
          liveExitDef.when.forEach((branch, i) => {
            edges.push({
              id: `${path}::${exitName}#${String(i)}`,
              from: path,
              to: resolveTarget(branch.to, path),
              exit: exitName,
              kind: 'submit',
              branchIndex: i,
              branchTotal: total,
              ...(liveExitDef.description !== undefined
                ? { description: liveExitDef.description }
                : {}),
            });
          });
        }
      }
    } else if (meta.kind === 'choice') {
      nodes.push({
        id: path,
        label: path,
        kind: 'choice',
        ...(meta.main === true ? { main: true } : {}),
        detail: describeChoiceNode(meta),
        ...parentField,
      });
      meta.options.forEach((option, i) => {
        edges.push({
          id: `${path}::choice#${String(i)}`,
          from: path,
          to: resolveTarget(option.to, path),
          exit: option.label,
          kind: 'choice',
        });
      });
    } else if (meta.kind === 'terminal') {
      nodes.push({
        id: path,
        label: path,
        kind: 'terminal',
        outcome: meta.outcome,
        ...(meta.main === true ? { main: true } : {}),
        detail: {
          outcome: meta.outcome,
          ...(meta.artifacts !== undefined ? { artifacts: Object.keys(meta.artifacts) } : {}),
        },
        ...parentField,
      });
    } else if (meta.kind === 'passive') {
      nodes.push({
        id: path,
        label: path,
        kind: 'passive',
        ...(meta.main === true ? { main: true } : {}),
        detail: {},
        ...parentField,
      });
    }

    if (meta.kind !== 'terminal') {
      edges.push(...extractAlwaysEdges(node, path, resolveTarget));
      edges.push(...extractInvokeDoneEdges(node, path, resolveTarget));
    }
  }

  for (const host of embedHosts.values()) {
    for (const finalId of host.meta.exits) {
      const wiring = host.meta.onMap[finalId];
      const target = wiring?.target;
      if (typeof target !== 'string' || target.length === 0) continue;
      const candidate = host.parentPrefix + target;
      edges.push({
        id: `${host.path}::embed-out::${finalId}`,
        from: `${host.path}.${finalId}`,
        to: embedHosts.get(candidate)?.entry ?? candidate,
        exit: finalId,
        kind: 'submit',
      });
    }
  }

  const root = machine.root as unknown as MachineRootShape;
  const rootInitialKey = root.initial?.target?.[0]?.key ?? nodes[0]?.id ?? '';
  const initial = embedHosts.get(rootInitialKey)?.entry ?? rootInitialKey;

  return {
    machineId: root.id,
    initial,
    nodes,
    edges,
  };
}

function describeText(value: unknown, dynamicLabel: string): TextDetail {
  if (typeof value === 'string') {
    return { kind: 'static', text: value };
  }
  return { kind: 'dynamic', text: inspectableText(value, dynamicLabel) };
}

function inspectableText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'function') return value.toString();
  return fallback;
}

function describeStatefulNode(
  meta: AharnessStateMeta,
  path: string,
  resolveTarget: (rawTo: string, sourcePath: string) => string,
  sidecar: SchemaSidecar | undefined,
): NonNullable<VizNode['detail']> {
  const hooks = describeHooks(meta);
  const skills = describeSkills(meta.skills);
  const exits = Object.entries(meta.exits).flatMap(([name, def]) => {
    const exitDef = def as DefaultedExitDef;
    if (!isLiveDefaultedExit(exitDef)) return [];
    return [describeExit(path, name, exitDef, resolveTarget, sidecar)];
  });

  return {
    entryPrompt: describeText(meta.entryPrompt, '<dynamic prompt>'),
    open: meta.open,
    ...(meta.clearOnEntry !== undefined ? { clearOnEntry: true } : {}),
    ...(meta.stopGuidance !== undefined ? { hasStopGuidance: true } : {}),
    ...(meta.onEntry !== undefined ? { hasOnEntry: true } : {}),
    ...(hooks.length > 0 ? { hooks } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    exits,
  };
}

function describeChoiceNode(meta: ChoiceMeta): NonNullable<VizNode['detail']> {
  return {
    question: describeText(meta.question, '<dynamic owner choice question>'),
    options: meta.options.map((option) => option.label),
  };
}

function isLiveDefaultedExit(def: DefaultedExitDef): def is LiveDefaultedExitDef {
  return '__aharnessPayloadMarker' in def && def.__aharnessPayloadMarker === true;
}

function describeExit(
  statePath: string,
  name: string,
  def: LiveDefaultedExitDef,
  resolveTarget: (rawTo: string, sourcePath: string) => string,
  sidecar: SchemaSidecar | undefined,
): ExitDetail {
  const description = def.description;
  if ('when' in def && Array.isArray(def.when)) {
    const branches = def.when as ReadonlyArray<{ readonly to: string }>;
    return {
      name,
      kind: 'submit',
      targets: branches.map((branch) => resolveTarget(branch.to, statePath)),
      branchCount: branches.length,
      ...(description !== undefined ? { description } : {}),
      ...(sidecar?.[statePath]?.[name]?.jsonSchema !== undefined
        ? { payloadSchema: sidecar[statePath]?.[name]?.jsonSchema }
        : {}),
    };
  }
  return {
    name,
    kind: 'submit',
    targets: [resolveTarget((def as { to: string }).to, statePath)],
    ...(description !== undefined ? { description } : {}),
    ...(sidecar?.[statePath]?.[name]?.jsonSchema !== undefined
      ? { payloadSchema: sidecar[statePath]?.[name]?.jsonSchema }
      : {}),
  };
}

function describeHooks(meta: AharnessStateMeta): HookDetail[] {
  const hooks = meta.hooks;
  if (hooks === undefined) return [];
  const out: HookDetail[] = [];
  if (hooks.preToolUse !== undefined && hooks.preToolUse.length > 0) {
    out.push({
      kind: 'PreToolUse',
      count: hooks.preToolUse.length,
      matchers: hooks.preToolUse.map((entry) => entry.matcher),
    });
  }
  if (hooks.postToolUse !== undefined && hooks.postToolUse.length > 0) {
    out.push({
      kind: 'PostToolUse',
      count: hooks.postToolUse.length,
      matchers: hooks.postToolUse.map((entry) => entry.matcher),
    });
  }
  if (hooks.userPromptSubmit !== undefined && hooks.userPromptSubmit.length > 0) {
    out.push({ kind: 'UserPromptSubmit', count: hooks.userPromptSubmit.length });
  }
  if (hooks.permissionRequest !== undefined && hooks.permissionRequest.length > 0) {
    out.push({
      kind: 'PermissionRequest',
      count: hooks.permissionRequest.length,
      matchers: hooks.permissionRequest.map((entry) => entry.matcher),
    });
  }
  return out;
}

function describeSkills(skills: ReadonlyArray<SkillRef> | undefined): SkillDetail[] {
  if (skills === undefined) return [];
  return skills.map((ref) => ({
    source: ref.source,
    label: ref.source === 'name' ? ref.name : ref.path,
    optional: ref.optional,
  }));
}
