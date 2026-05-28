import type { Topology } from '../types/topology.js';
import type { Scene } from './script.js';
import { enter, modelMsg, submitFrame, syntheticOrientation, turnDone } from './helpers.js';

const ROOT = 'embed_demo';
const path = (leaf: string) => `${ROOT}.${leaf}`;
const host = path('delegate');
const child = (leaf: string) => `${host}.${leaf}`;
const nested = child('nested');
const nestedChild = (leaf: string) => `${nested}.${leaf}`;

export const topology: Topology = {
  machineId: ROOT,
  initial: path('start'),
  nodes: [
    {
      id: path('start'),
      label: path('start'),
      kind: 'stateful',
      entryPrompt: 'Start the embed layout fixture and submit `choose`.',
    },
    {
      id: path('branch'),
      label: path('branch'),
      kind: 'stateful',
      entryPrompt: 'Branch into either a retry loop or the embedded workflow.',
    },
    {
      id: path('retry'),
      label: path('retry'),
      kind: 'stateful',
      entryPrompt: 'Exercise a visible self-loop before returning to the embed host.',
    },
    {
      id: host,
      label: host,
      kind: 'embed',
      entry: child('start'),
    },
    {
      id: path('done'),
      label: path('done'),
      kind: 'terminal',
      outcome: 'success',
    },
    {
      id: path('failed'),
      label: path('failed'),
      kind: 'terminal',
      outcome: 'failure',
    },
    {
      id: child('start'),
      label: child('start'),
      kind: 'stateful',
      parent: host,
      entryPrompt: 'Choose a child terminal or expand the nested embed.',
    },
    {
      id: nested,
      label: nested,
      kind: 'embed',
      parent: host,
      entry: nestedChild('start'),
    },
    {
      id: child('success'),
      label: child('success'),
      kind: 'terminal',
      parent: host,
      outcome: 'success',
    },
    {
      id: child('failure'),
      label: child('failure'),
      kind: 'terminal',
      parent: host,
      outcome: 'failure',
    },
    {
      id: nestedChild('start'),
      label: nestedChild('start'),
      kind: 'stateful',
      parent: nested,
      entryPrompt: 'Nested embed entry.',
    },
    {
      id: nestedChild('done'),
      label: nestedChild('done'),
      kind: 'terminal',
      parent: nested,
      outcome: 'success',
    },
  ],
  edges: [
    {
      id: `${path('start')}::choose`,
      from: path('start'),
      to: path('branch'),
      exit: 'choose',
      kind: 'submit',
    },
    {
      id: `${path('branch')}::retry_path`,
      from: path('branch'),
      to: path('retry'),
      exit: 'route',
      kind: 'submit',
      branchIndex: 0,
      branchTotal: 2,
    },
    {
      id: `${path('branch')}::embed_path`,
      from: path('branch'),
      to: host,
      exit: 'route',
      kind: 'submit',
      branchIndex: 1,
      branchTotal: 2,
    },
    {
      id: `${path('retry')}::again`,
      from: path('retry'),
      to: path('retry'),
      exit: 'again',
      kind: 'submit',
    },
    {
      id: `${path('retry')}::delegate`,
      from: path('retry'),
      to: host,
      exit: 'delegate',
      kind: 'submit',
    },
    {
      id: `${child('start')}::child_success`,
      from: child('start'),
      to: child('success'),
      exit: 'child_success_with_a_long_label',
      kind: 'submit',
    },
    {
      id: `${child('start')}::child_failure`,
      from: child('start'),
      to: child('failure'),
      exit: 'child_failure',
      kind: 'submit',
    },
    {
      id: `${child('start')}::nested`,
      from: child('start'),
      to: nested,
      exit: 'nested',
      kind: 'submit',
    },
    {
      id: `${nestedChild('start')}::finish`,
      from: nestedChild('start'),
      to: nestedChild('done'),
      exit: 'finish_nested',
      kind: 'submit',
    },
    {
      id: `${nestedChild('done')}::embed_final`,
      from: nestedChild('done'),
      to: child('success'),
      exit: 'embed-final',
      kind: 'always',
    },
    {
      id: `${child('success')}::root_done`,
      from: child('success'),
      to: path('done'),
      exit: 'embed-final',
      kind: 'always',
    },
    {
      id: `${child('failure')}::root_failed`,
      from: child('failure'),
      to: path('failed'),
      exit: 'embed-final',
      kind: 'always',
    },
  ],
};

export const scenes: Scene[] = [
  {
    id: 'boot',
    frames: [
      enter(path('start'), 'boot', null, false, 1),
      ...modelMsg(
        'embed-m-1',
        'Embed fixture booted; routing through retry before entering child state.',
      ),
    ],
    autoAdvance: { gapMs: 650 },
  },
  {
    id: 'choose-branch',
    frames: [
      submitFrame('embed-submit-1', { state: path('start'), exit: 'choose', data: {} }),
      turnDone('embed-turn-1'),
      enter(path('branch'), 'submit', path('start'), false, 1),
      syntheticOrientation('embed-orient-1', path('branch')),
    ],
    autoAdvance: { gapMs: 650 },
  },
  {
    id: 'route-retry',
    frames: [
      submitFrame('embed-submit-2', { state: path('branch'), exit: 'retry_path', data: {} }),
      turnDone('embed-turn-2'),
      enter(path('retry'), 'submit', path('branch'), false, 1),
      syntheticOrientation('embed-orient-2', path('retry')),
    ],
    autoAdvance: { gapMs: 650 },
  },
  {
    id: 'retry-self-loop',
    frames: [
      submitFrame('embed-submit-3', { state: path('retry'), exit: 'again', data: { attempt: 1 } }),
      turnDone('embed-turn-3'),
      enter(path('retry'), 'submit', path('retry'), false, 2),
      syntheticOrientation('embed-orient-3', path('retry')),
    ],
    autoAdvance: { gapMs: 650 },
  },
  {
    id: 'enter-embed-child',
    frames: [
      submitFrame('embed-submit-4', { state: path('retry'), exit: 'delegate', data: {} }),
      turnDone('embed-turn-4'),
      enter(child('start'), 'submit', path('retry'), false, 1),
      syntheticOrientation('embed-orient-4', child('start')),
    ],
    autoAdvance: { gapMs: 650 },
  },
  {
    id: 'enter-nested-child',
    frames: [
      submitFrame('embed-submit-5', { state: child('start'), exit: 'nested', data: {} }),
      turnDone('embed-turn-5'),
      enter(nestedChild('start'), 'submit', child('start'), false, 1),
      syntheticOrientation('embed-orient-5', nestedChild('start')),
    ],
  },
];
