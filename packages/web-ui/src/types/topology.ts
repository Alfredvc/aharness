// Mirror of the @aharness/core run UI topology shape. Production hydrates this
// through run-scoped bootstrap; fixture/demo flows may still provide topology
// outside the production entry path.

export type NodeKind = 'stateful' | 'terminal' | 'passive' | 'choice' | 'embed';

export type TextDetail = {
  kind: 'static' | 'dynamic';
  text: string;
};

export type HookDetail = {
  kind: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'PermissionRequest';
  count: number;
  matchers?: string[];
};

export type SkillDetail = {
  source: 'name' | 'path';
  label: string;
  optional: boolean;
};

export type ExitDetail = {
  name: string;
  kind: EdgeKind;
  targets: string[];
  branchCount?: number;
  description?: string;
  payloadSchema?: unknown;
};

export type VizNodeDetail = {
  entryPrompt?: TextDetail;
  // Historical/bootstrap fixture compatibility only. Current owner decisions
  // appear as choice nodes with `question` and `options`.
  awaitsOwnerText?: TextDetail;
  question?: TextDetail;
  options?: string[];
  open?: boolean;
  clearOnEntry?: boolean;
  hasStopGuidance?: boolean;
  hasOnEntry?: boolean;
  hooks?: HookDetail[];
  skills?: SkillDetail[];
  exits?: ExitDetail[];
  outcome?: 'success' | 'failure';
  artifacts?: string[];
};

export type VizNode = {
  id: string;
  label: string;
  kind: NodeKind;
  open?: boolean;
  main?: true;
  // Historical/bootstrap fixture compatibility only; not a current authoring
  // surface for owner decisions.
  awaitsOwnerText?: boolean;
  outcome?: 'success' | 'failure';
  entryPrompt?: string;
  parent?: string;
  entry?: string;
  detail?: VizNodeDetail;
};

// `await` is retained only for historical topology rows and legacy fixtures.
export type EdgeKind = 'submit' | 'await' | 'always' | 'choice';

export type VizEdge = {
  id: string;
  from: string;
  to: string;
  exit: string;
  kind: EdgeKind;
  branchIndex?: number;
  branchTotal?: number;
  description?: string;
};

export type Topology = {
  machineId: string;
  initial: string;
  nodes: VizNode[];
  edges: VizEdge[];
};
