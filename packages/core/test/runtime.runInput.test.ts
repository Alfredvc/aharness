import { describe, expect, it } from 'vitest';
import type { JSONSchema7 } from 'json-schema';

import {
  applyRunInputDefaults,
  createActorRunInput,
  normalizeProgrammaticRunInput,
} from '../src/runtime/runInput.js';
import type { ArgFlagMeta } from '../src/loader/inputSchema.js';

const schema: JSONSchema7 = {
  type: 'object',
  properties: {
    project: { type: 'string' },
    retries: { type: 'number' },
    dryRun: { type: 'boolean' },
  },
  required: ['project'],
  additionalProperties: false,
};

const flags: Record<string, ArgFlagMeta> = {
  project: {},
  retries: { default: 2 },
  dryRun: { default: false },
};

describe('normalizeProgrammaticRunInput', () => {
  it('applies declared input defaults without mutating caller input', () => {
    const input = { project: 'demo' };

    const result = normalizeProgrammaticRunInput({
      targetLabel: './workflow.fsm.ts',
      input,
      inputSchema: schema,
      inputFlags: flags,
    });

    expect(result).toEqual({
      ok: true,
      input: { project: 'demo', retries: 2, dryRun: false },
    });
    expect(input).toEqual({ project: 'demo' });
  });

  it('does not replace explicitly supplied undefined values with defaults', () => {
    const result = normalizeProgrammaticRunInput({
      targetLabel: './workflow.fsm.ts',
      input: { project: 'demo', retries: undefined },
      inputSchema: schema,
      inputFlags: flags,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('--retries');
  });

  it('validates programmatic values without CLI string coercion', () => {
    const result = normalizeProgrammaticRunInput({
      targetLabel: './workflow.fsm.ts',
      input: { project: 'demo', retries: '5' },
      inputSchema: schema,
      inputFlags: flags,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('invalid input for ./workflow.fsm.ts');
      expect(result.errors.join('\n')).toContain('--retries');
      expect(result.errors.join('\n')).toContain('must be number');
    }
  });

  it('reports missing required and unknown fields with target context', () => {
    const result = normalizeProgrammaticRunInput({
      targetLabel: 'installed:demo',
      input: { unexpectedField: true },
      inputSchema: schema,
      inputFlags: flags,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('invalid input for installed:demo');
      expect(result.errors.join('\n')).toContain('--project: required input is missing');
      expect(result.errors.join('\n')).toContain('--unexpected-field: unknown input field');
    }
  });

  it.each([
    ['array', []],
    ['null', null],
    ['string', 'demo'],
    ['number', 1],
    ['boolean', true],
  ])('rejects non-record input values: %s', (_name, input) => {
    const result = normalizeProgrammaticRunInput({
      targetLabel: './workflow.fsm.ts',
      input,
      inputSchema: schema,
      inputFlags: flags,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('invalid input for ./workflow.fsm.ts');
      expect(result.errors[0]).toContain('input must be an object');
    }
  });

  it('accepts absent and empty input when no input schema is declared', () => {
    expect(
      normalizeProgrammaticRunInput({
        targetLabel: './no-input.fsm.ts',
      }),
    ).toEqual({ ok: true, input: {} });
    expect(
      normalizeProgrammaticRunInput({
        targetLabel: './no-input.fsm.ts',
        input: {},
      }),
    ).toEqual({ ok: true, input: {} });
  });

  it('rejects non-empty object input when no input schema is declared', () => {
    const result = normalizeProgrammaticRunInput({
      targetLabel: './no-input.fsm.ts',
      input: { project: 'demo' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('invalid input for ./no-input.fsm.ts');
      expect(result.errors.join('\n')).toContain('FSM declares no input fields');
      expect(result.errors.join('\n')).toContain('--project');
    }
  });
});

describe('applyRunInputDefaults', () => {
  it('adds only omitted defaults', () => {
    expect(applyRunInputDefaults({ project: 'demo', dryRun: true }, flags)).toEqual({
      project: 'demo',
      retries: 2,
      dryRun: true,
    });
  });
});

describe('createActorRunInput', () => {
  it('merges framework fields first so user input wins on collisions', () => {
    expect(
      createActorRunInput(
        'framework-run',
        { root: '/tmp/run' },
        {
          runId: 'user-run',
          runDir: 'user-dir',
          project: 'demo',
        },
      ),
    ).toEqual({
      runId: 'user-run',
      runDir: 'user-dir',
      project: 'demo',
    });
  });
});
