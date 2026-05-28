/**
 * The walk fixture is a stable reference for the example FSM's authored
 * surface. If a state or exit is renamed in `requirement-spec.fsm.ts`,
 * these structural assertions break and remind the author to update the
 * walk before re-greening `phase9.realtui.e2e.test.ts`.
 *
 * (Random IDs inside `sseFunctionCall` / `sseTurnComplete` rule out a
 * literal `toMatchInlineSnapshot` of the builder output; we assert the
 * structure instead.)
 */

import { describe, expect, it } from 'vitest';

import {
  REQUIREMENT_SPEC_SHORTEST_WALK,
  buildAssistantTurnForOwnerText,
  buildSubmitTurn,
} from '../../src/index.js';

const EXPECTED_SUBMIT_STATES = [
  'askGoal',
  'iterateRequirements',
  'research',
  'flagIncompatibilities',
  'probeMissingRequirements',
  'reviseWithOwner',
  'reviewerPass',
] as const;

describe('REQUIREMENT_SPEC_SHORTEST_WALK', () => {
  it('targets every authored stateful state exactly once via a submit step', () => {
    const submitStates = REQUIREMENT_SPEC_SHORTEST_WALK.flatMap((s) =>
      s.kind === 'submit' ? [s.stateId] : [],
    );
    expect(submitStates).toEqual([...EXPECTED_SUBMIT_STATES]);
  });

  it('schedules an owner-yield before each await state', () => {
    const flat = REQUIREMENT_SPEC_SHORTEST_WALK.map((s) =>
      s.kind === 'requestUserInput'
        ? { kind: 'r', message: s.messageToUser, reply: s.ownerReply }
        : { kind: 's', state: s.stateId },
    );
    expect(flat).toEqual([
      { kind: 'r', message: 'What is your goal?', reply: 'ship the prototype' },
      { kind: 's', state: 'askGoal' },
      { kind: 's', state: 'iterateRequirements' },
      { kind: 's', state: 'research' },
      { kind: 's', state: 'flagIncompatibilities' },
      { kind: 'r', message: 'Any gaps?', reply: 'no' },
      { kind: 's', state: 'probeMissingRequirements' },
      { kind: 'r', message: 'Any edits?', reply: 'looks good' },
      { kind: 's', state: 'reviseWithOwner' },
      { kind: 's', state: 'reviewerPass' },
    ]);
  });
});

describe('builders', () => {
  it('buildAssistantTurnForOwnerText emits text + request_user_input (built-in, no namespace) + completed', () => {
    const turn = buildAssistantTurnForOwnerText('What is your goal?');
    expect(turn).toHaveLength(3);
    expect(turn[0]?.event).toBe('response.output_item.done');
    expect((turn[0]?.data as { item: { content: { text: string }[] } }).item.content[0]?.text).toBe(
      'What is your goal?',
    );
    const fnItem = (
      turn[1]?.data as {
        item: { name: string; namespace?: string; arguments: string };
      }
    ).item;
    expect(fnItem.name).toBe('request_user_input');
    // Built-in tool — no MCP namespace.
    expect(fnItem.namespace).toBeUndefined();
    expect(JSON.parse(fnItem.arguments)).toEqual({
      questions: [
        {
          id: 'owner',
          header: '',
          question: 'What is your goal?',
          options: [
            {
              label: 'Custom answer (Recommended)',
              description: 'Type the requested owner reply.',
            },
          ],
        },
      ],
    });
    expect(turn[2]?.event).toBe('response.completed');
  });

  it('buildSubmitTurn emits a single submit function call with split namespace + completed', () => {
    const turn = buildSubmitTurn('reviewerPass', 'submit', { verdict: 'pass', notes: 'ok' });
    expect(turn).toHaveLength(2);
    const item = (
      turn[0]?.data as {
        item: { name: string; namespace?: string; arguments: string };
      }
    ).item;
    expect(item.name).toBe('submit');
    expect(item.namespace).toBe('mcp__aharness_fsm__');
    expect(JSON.parse(item.arguments)).toEqual({
      state: 'reviewerPass',
      exit: 'submit',
      data: { verdict: 'pass', notes: 'ok' },
    });
    expect(turn[1]?.event).toBe('response.completed');
  });
});
