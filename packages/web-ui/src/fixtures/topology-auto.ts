// Mock topology for the `autonomous_repair` example FSM — fully autonomous,
// no owner interaction, no approvals. `attempt` self-loops on `retry` to
// exercise visit-count rendering + the multi-visit transcript view.

import type { Topology } from '../types/topology.js';

const ROOT = 'autonomous_repair';
const path = (leaf: string) => `${ROOT}.${leaf}`;

export const topology: Topology = {
  machineId: ROOT,
  initial: path('probe'),
  nodes: [
    {
      id: path('probe'),
      label: path('probe'),
      kind: 'stateful',
      entryPrompt:
        'Probe the failing target. Read the relevant files, identify candidate fixes, then submit `analyzed`.',
    },
    {
      id: path('attempt'),
      label: path('attempt'),
      kind: 'stateful',
      entryPrompt:
        'Apply a patch and run the test suite. Submit `passed` on green, `retry` to try a different fix, `exhausted` after the budget is spent.',
    },
    {
      id: path('done_success'),
      label: path('done_success'),
      kind: 'terminal',
      outcome: 'success',
    },
    {
      id: path('done_failure'),
      label: path('done_failure'),
      kind: 'terminal',
      outcome: 'failure',
    },
  ],
  edges: [
    {
      id: `${path('probe')}::analyzed`,
      from: path('probe'),
      to: path('attempt'),
      exit: 'analyzed',
      kind: 'submit',
    },
    {
      id: `${path('attempt')}::passed`,
      from: path('attempt'),
      to: path('done_success'),
      exit: 'passed',
      kind: 'submit',
    },
    {
      id: `${path('attempt')}::retry`,
      from: path('attempt'),
      to: path('attempt'),
      exit: 'retry',
      kind: 'submit',
    },
    {
      id: `${path('attempt')}::exhausted`,
      from: path('attempt'),
      to: path('done_failure'),
      exit: 'exhausted',
      kind: 'submit',
    },
  ],
};
