/**
 * Tests for `runtime/nudge.ts` — the per-state orientation composer used
 * to start model turns with the active state's submit guidance. The
 * composer is pure and deterministic; these tests pin the textual
 * contract end-to-end.
 */
import { describe, expect, it } from 'vitest';
import { composeStateNudge } from '../src/runtime/nudge.js';

describe('composeStateNudge', () => {
  it('renders submit exits with schemas inline', () => {
    const n = composeStateNudge({
      stateId: 'iterateRequirements',
      exits: [
        {
          kind: 'submit',
          name: 'submit',
          schema: { type: 'object', properties: { done: { type: 'boolean' } } },
        },
      ],
      entryPromptText: 'List one requirement, then call submit.',
    });
    expect(n).toContain('[aharness] Now in state "iterateRequirements".');
    expect(n).toContain('Valid exits:');
    expect(n).toContain(
      '"submit" → call aharness_submit({state: "iterateRequirements", exit: "submit", data: ',
    );
    expect(n).toContain('"done"'); // schema embedded inline on the bullet line
    expect(n).toContain('List one requirement, then call submit.');
    expect(n).not.toContain('request_user_input');
    expect(n.split('\n').filter((line) => line.trim().startsWith('-'))).toEqual([
      expect.stringContaining('aharness_submit'),
    ]);
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

  it('does not render request_user_input guidance for submit states', () => {
    const n = composeStateNudge({
      stateId: 's',
      exits: [{ kind: 'submit', name: 'go', schema: { type: 'object' } }],
      entryPromptText: '',
    });
    expect(n).not.toContain('request_user_input');
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

  it('does not append manual skill blocks to orientation text', () => {
    const n = composeStateNudge({
      stateId: 's',
      exits: [{ kind: 'submit', name: 'go', schema: { type: 'object' } }],
      entryPromptText: 'x',
    });
    expect(n).not.toContain('<skill');
    expect(n).not.toContain('"type":"skill"');
  });
});
