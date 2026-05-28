// Mirror of the @aharness/core run UI topology shape. Production hydrates this
// through /api/state; fixture/demo flows may still provide topology outside the
// production entry path.

export type NodeKind = 'stateful' | 'terminal' | 'passive' | 'embed';

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
  awaitsOwnerText?: TextDetail;
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
  awaitsOwnerText?: boolean;
  outcome?: 'success' | 'failure';
  entryPrompt?: string;
  parent?: string;
  entry?: string;
  detail?: VizNodeDetail;
};

export type EdgeKind = 'submit' | 'await' | 'always';

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
