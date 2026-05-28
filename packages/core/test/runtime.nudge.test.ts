/**
 * Tests for `runtime/nudge.ts` — the per-state orientation composer fed
 * into `thread/inject_items` at every state entry. The composer is pure
 * and deterministic; these tests pin the textual contract end-to-end.
 */
import { describe, expect, it } from 'vitest';
import { composeStateNudge } from '../src/runtime/nudge.js';

describe('composeStateNudge', () => {
  it('renders submit + await exits with schemas inline', () => {
    const n = composeStateNudge({
      stateId: 'iterateRequirements',
      exits: [
        {
          kind: 'submit',
          name: 'submit',
          schema: { type: 'object', properties: { done: { type: 'boolean' } } },
        },
        { kind: 'await', name: 'wait' },
      ],
      entryPromptText: 'List one requirement, then call submit.',
    });
    expect(n).toContain('[aharness] Now in state "iterateRequirements".');
    expect(n).toContain('Valid exits:');
    expect(n).toContain(
      '"submit" → call aharness_submit({state: "iterateRequirements", exit: "submit", data: ',
    );
    expect(n).toContain('"wait" → call request_user_input');
    expect(n).toContain('"done"'); // schema embedded inline on the bullet line
    expect(n).toContain('List one requirement, then call submit.');
  });

  it('renders canonical await ask text on the await exit instruction', () => {
    const n = composeStateNudge({
      stateId: 'lint',
      exits: [{ kind: 'await', name: 'proceed', ask: 'Lint passed. Proceed?' }],
      entryPromptText: 'Wait for the owner.',
    });
    expect(n).toContain(
      '"proceed" → call request_user_input({"questions":[{"id":"owner","header":"","question":"Lint passed. Proceed?","options":[{"label":"Custom answer (Recommended)","description":"Type the requested owner reply."}]}]})',
    );
    expect(n).toContain('(await exit, no submit data)');
  });

  it('omits the prompt section when entryPromptText is empty', () => {
    const n = composeStateNudge({
      stateId: 's',
      exits: [{ kind: 'submit', name: 'go', schema: { type: 'object' } }],
      entryPromptText: '',
    });
    expect(n).toContain('[aharness] Now in state "s".');
    // No trailing blank-line + prompt-text block: the message ends with
    // the exits section. With the compact one-line schema rendering
    // each submit exit's bullet IS the last line; there is no blank
    // separator line that would prefix a prompt block.
    expect(n).not.toMatch(/\n\n[^\s]/);
  });

  it('renders the bullet line with the expected `  - ` prefix', () => {
    const n = composeStateNudge({
      stateId: 's',
      exits: [{ kind: 'submit', name: 'go', schema: { type: 'object' } }],
      entryPromptText: '',
    });
    const bulletLine = n.split('\n').find((l) => l.includes('"go" →'));
    expect(bulletLine).toMatch(/^ {2}- /);
  });

  it('prepends a request_user_input preamble when awaitsOwnerText is set', () => {
    const n = composeStateNudge({
      stateId: 'askGoal',
      exits: [
        {
          kind: 'submit',
          name: 'submit',
          schema: { type: 'object', properties: { goal: { type: 'string' } } },
        },
      ],
      entryPromptText: '',
      awaitsOwnerText: { messageToUser: 'What is your goal?' },
    });
    expect(n).toContain(
      'Before submitting, call request_user_input({"questions":[{"id":"owner","header":"","question":"What is your goal?","options":[{"label":"Custom answer (Recommended)","description":"Type the requested owner reply."}]}]})',
    );
    // Preamble appears BEFORE the "Valid exits:" section.
    expect(n.indexOf('request_user_input')).toBeLessThan(n.indexOf('Valid exits:'));
  });

  it('omits the request_user_input preamble when awaitsOwnerText is unset', () => {
    const n = composeStateNudge({
      stateId: 's',
      exits: [{ kind: 'submit', name: 'go', schema: { type: 'object' } }],
      entryPromptText: '',
    });
    expect(n).not.toContain('Before submitting, call request_user_input');
  });

  it('renders the schema on a single line with $schema and empty definitions stripped', () => {
    const n = composeStateNudge({
      stateId: 's',
      exits: [
        {
          kind: 'submit',
          name: 'go',
          schema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: { color: { type: 'string', enum: ['red', 'green'] } },
            required: ['color'],
            additionalProperties: false,
            definitions: {},
          },
        },
      ],
      entryPromptText: '',
    });
    const bulletLine = n.split('\n').find((l) => l.includes('"go" →'));
    expect(bulletLine).toBeDefined();
    // No multi-line schema dump: the bullet line carries the full schema.
    expect(bulletLine).toContain('"type":"object"');
    expect(bulletLine).toContain('"enum":["red","green"]');
    // Stripped: schema URI and empty definitions add no information.
    expect(bulletLine).not.toContain('$schema');
    expect(bulletLine).not.toContain('definitions');
    // Trailing `})` follows the schema, no leading whitespace at start
    // of the schema (everything on one line).
    expect(bulletLine).toMatch(/data: \{.+\}\)$/);
  });

  it('preserves non-empty definitions for $ref resolution', () => {
    const n = composeStateNudge({
      stateId: 's',
      exits: [
        {
          kind: 'submit',
          name: 'go',
          schema: {
            type: 'object',
            properties: { item: { $ref: '#/definitions/Item' } },
            definitions: {
              Item: { type: 'object', properties: { id: { type: 'string' } } },
            },
          },
        },
      ],
      entryPromptText: '',
    });
    expect(n).toContain('"definitions"');
    expect(n).toContain('"Item"');
  });

  it('appends skillBlocks after the entryPromptText', () => {
    const n = composeStateNudge({
      stateId: 's',
      exits: [{ kind: 'submit', name: 'go', schema: { type: 'object' } }],
      entryPromptText: 'Do the thing.',
      skillBlocks: [
        '<skill name="alpha" path="/a/SKILL.md">\nbody-a\n</skill>',
        '<skill name="beta" path="/b/SKILL.md">\nbody-b\n</skill>',
      ],
    });
    expect(n).toContain('Do the thing.');
    expect(n).toContain('<skill name="alpha"');
    expect(n).toContain('body-a');
    expect(n).toContain('<skill name="beta"');
    expect(n).toContain('body-b');
    // skill blocks land AFTER the entry prompt text
    expect(n.indexOf('Do the thing.')).toBeLessThan(n.indexOf('<skill name="alpha"'));
  });

  it('omits skill section when skillBlocks is empty or absent', () => {
    const n1 = composeStateNudge({
      stateId: 's',
      exits: [{ kind: 'submit', name: 'go', schema: { type: 'object' } }],
      entryPromptText: 'x',
      skillBlocks: [],
    });
    const n2 = composeStateNudge({
      stateId: 's',
      exits: [{ kind: 'submit', name: 'go', schema: { type: 'object' } }],
      entryPromptText: 'x',
    });
    expect(n1).not.toContain('<skill');
    expect(n2).not.toContain('<skill');
  });

  it('escapes the messageToUser through JSON.stringify (quotes, newlines)', () => {
    const n = composeStateNudge({
      stateId: 's',
      exits: [{ kind: 'submit', name: 'go', schema: { type: 'object' } }],
      entryPromptText: '',
      awaitsOwnerText: { messageToUser: 'Tell me "everything"\nincluding edge cases.' },
    });
    expect(n).toContain('"question":"Tell me \\"everything\\"\\nincluding edge cases."');
  });
});
