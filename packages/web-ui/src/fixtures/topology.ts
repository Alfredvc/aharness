// Mock topology for the requirement_spec example FSM. Mirrors what
// @aharness/core's extractTopology would emit when the headless CLI calls
// /api/topology at boot. Hand-authored for the fixture flow.

import type { Topology } from '../types/topology.js';

const ROOT = 'requirement_spec';
const path = (leaf: string) => `${ROOT}.${leaf}`;

export const topology: Topology = {
  machineId: ROOT,
  initial: path('gathering_constraints'),
  nodes: [
    {
      id: path('gathering_constraints'),
      label: path('gathering_constraints'),
      kind: 'stateful',
      // Legacy-display fixture compatibility only; current owner decisions use
      // choice nodes or owner-input pending cards.
      awaitsOwnerText: true,
      entryPrompt:
        'Ask the owner for purpose, stakeholders, and mandated constraints. Then submit with exit `proceed`.',
    },
    {
      id: path('drafting_drivers'),
      label: path('drafting_drivers'),
      kind: 'stateful',
      entryPrompt:
        'Draft the Project Drivers artifact. Submit `present` when clean, `ask_followup` if a constraint is ambiguous.',
    },
    {
      id: path('clarifying'),
      label: path('clarifying'),
      kind: 'stateful',
      // Legacy-display fixture compatibility only; current owner decisions use
      // choice nodes or owner-input pending cards.
      awaitsOwnerText: true,
      entryPrompt: 'Ask one targeted clarification, then `resolved` back to drafting.',
    },
    {
      id: path('review'),
      label: path('review'),
      kind: 'choice',
      detail: {
        question: { kind: 'static', text: 'How should the draft proceed?' },
        options: ['approve', 'reject', 'revisit'],
      },
    },
    {
      id: path('present'),
      label: path('present'),
      kind: 'stateful',
      entryPrompt: 'Final presentation pass. Submit `ship` or `abort`.',
    },
    {
      id: path('done_success'),
      label: path('done_success'),
      kind: 'terminal',
      outcome: 'success',
    },
    {
      id: path('done_abort'),
      label: path('done_abort'),
      kind: 'terminal',
      outcome: 'failure',
    },
  ],
  edges: [
    {
      id: `${path('gathering_constraints')}::proceed`,
      from: path('gathering_constraints'),
      to: path('drafting_drivers'),
      exit: 'proceed',
      kind: 'submit',
    },
    {
      id: `${path('drafting_drivers')}::present`,
      from: path('drafting_drivers'),
      to: path('review'),
      exit: 'present',
      kind: 'submit',
    },
    {
      id: `${path('drafting_drivers')}::ask_followup`,
      from: path('drafting_drivers'),
      to: path('clarifying'),
      exit: 'ask_followup',
      kind: 'submit',
    },
    {
      id: `${path('clarifying')}::resolved`,
      from: path('clarifying'),
      to: path('drafting_drivers'),
      exit: 'resolved',
      kind: 'submit',
    },
    {
      id: `${path('review')}::approve`,
      from: path('review'),
      to: path('present'),
      exit: 'approve',
      kind: 'choice',
    },
    {
      id: `${path('review')}::reject`,
      from: path('review'),
      to: path('drafting_drivers'),
      exit: 'reject',
      kind: 'choice',
    },
    {
      id: `${path('review')}::revisit`,
      from: path('review'),
      to: path('review'),
      exit: 'revisit',
      kind: 'choice',
    },
    {
      id: `${path('present')}::ship`,
      from: path('present'),
      to: path('done_success'),
      exit: 'ship',
      kind: 'submit',
    },
    {
      id: `${path('present')}::abort`,
      from: path('present'),
      to: path('done_abort'),
      exit: 'abort',
      kind: 'submit',
    },
  ],
};
