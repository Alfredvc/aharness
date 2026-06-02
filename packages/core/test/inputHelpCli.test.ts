import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { formatLocalFsmInputHelp, runLocalFsmInputHelpForTest } from '../src/cli/inputHelpCli.js';
import type { extractSchemaSidecar } from '../src/loader/sidecar.js';

function makeWritableBuffer(): {
  readonly sink: NodeJS.WritableStream;
  text(): string;
} {
  const chunks: string[] = [];
  const sink = new PassThrough();
  sink.on('data', (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  });
  return { sink, text: () => chunks.join('') };
}

const typedFixture = 'packages/core/test/fixtures/args/input-help.fsm.ts';
const emptyFixture = 'packages/core/test/fixtures/args/empty-input.fsm.ts';
const throwsOnImportFixture = 'packages/core/test/fixtures/args/input-help-throws-on-import.fsm.ts';

describe('formatLocalFsmInputHelp', () => {
  it('renders usage, target paths, grouped input flags, markers, defaults, and descriptions', () => {
    const text = formatLocalFsmInputHelp({
      usage: 'aharness run ./workflow.fsm.ts --help',
      target: './workflow.fsm.ts',
      filePath: '/repo/workflow.fsm.ts',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          dryRun: { type: 'boolean' },
          count: { type: 'integer' },
          payload: { type: 'object', properties: { id: { type: 'string' } } },
          ratio: { type: 'number' },
        },
        required: ['topic', 'payload'],
        additionalProperties: false,
      },
      inputFlags: {
        topic: { description: 'Project topic' },
        dryRun: { description: 'Skip writes', default: false },
        count: { default: 2 },
        payload: { description: 'JSON payload' },
        ratio: { default: 0.5 },
      },
    });

    expect(text).toBe(
      [
        'Usage: aharness run ./workflow.fsm.ts --help',
        'Target: ./workflow.fsm.ts',
        'FSM: /repo/workflow.fsm.ts',
        '',
        'Required input flags:',
        '  --payload <value> (object) - JSON payload',
        '  --topic <string> (string) - Project topic',
        'Optional input flags:',
        '  --count <integer> (integer, default: 2)',
        '  --dry-run (boolean, default: false) - Skip writes',
        '  --ratio <number> (number, default: 0.5)',
        '',
      ].join('\n'),
    );
  });

  it('renders none for required input flags when all declared inputs are optional', () => {
    const text = formatLocalFsmInputHelp({
      usage: 'aharness run ./workflow.fsm.ts --help',
      target: './workflow.fsm.ts',
      filePath: '/repo/workflow.fsm.ts',
      inputSchema: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean' },
          count: { type: 'integer' },
        },
        additionalProperties: false,
      },
      inputFlags: {
        dryRun: { description: 'Skip writes', default: false },
        count: { default: 2 },
      },
    });

    expect(text).toBe(
      [
        'Usage: aharness run ./workflow.fsm.ts --help',
        'Target: ./workflow.fsm.ts',
        'FSM: /repo/workflow.fsm.ts',
        '',
        'Required input flags:',
        '  none',
        'Optional input flags:',
        '  --count <integer> (integer, default: 2)',
        '  --dry-run (boolean, default: false) - Skip writes',
        '',
      ].join('\n'),
    );
  });

  it('renders none for optional input flags when all declared inputs are required', () => {
    const text = formatLocalFsmInputHelp({
      usage: 'aharness run ./workflow.fsm.ts --help',
      target: './workflow.fsm.ts',
      filePath: '/repo/workflow.fsm.ts',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          payload: { type: 'object', properties: { id: { type: 'string' } } },
        },
        required: ['topic', 'payload'],
        additionalProperties: false,
      },
      inputFlags: {
        topic: { description: 'Project topic' },
        payload: { description: 'JSON payload' },
      },
    });

    expect(text).toBe(
      [
        'Usage: aharness run ./workflow.fsm.ts --help',
        'Target: ./workflow.fsm.ts',
        'FSM: /repo/workflow.fsm.ts',
        '',
        'Required input flags:',
        '  --payload <value> (object) - JSON payload',
        '  --topic <string> (string) - Project topic',
        'Optional input flags:',
        '  none',
        '',
      ].join('\n'),
    );
  });

  it('renders no declared inputs when inputSchema is undefined', () => {
    const text = formatLocalFsmInputHelp({
      usage: 'aharness run no-input.fsm.ts --help',
      target: 'no-input.fsm.ts',
      filePath: '/repo/no-input.fsm.ts',
      inputSchema: undefined,
      inputFlags: undefined,
    });

    expect(text).toBe(
      [
        'Usage: aharness run no-input.fsm.ts --help',
        'Target: no-input.fsm.ts',
        'FSM: /repo/no-input.fsm.ts',
        '',
        'Inputs: none',
        '',
      ].join('\n'),
    );
  });
});

describe('runLocalFsmInputHelpForTest', () => {
  it('resolves the target against cwd and uses sidecar extraction only', async () => {
    const stdout = makeWritableBuffer();
    const stderr = makeWritableBuffer();
    const extractSchemaSidecarImpl = vi.fn<typeof extractSchemaSidecar>(async () => ({
      sidecar: {},
      issues: [],
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      inputFlags: { name: { description: 'Run name' } },
    }));

    const result = await runLocalFsmInputHelpForTest({
      cwd: '/repo',
      target: './workflow.fsm.ts',
      usage: 'aharness run ./workflow.fsm.ts --help',
      stdout: stdout.sink,
      stderr: stderr.sink,
      extractSchemaSidecarImpl,
    });

    expect(result.exitCode).toBe(0);
    expect(extractSchemaSidecarImpl).toHaveBeenCalledWith({ filePath: '/repo/workflow.fsm.ts' });
    expect(stderr.text()).toBe('');
    expect(stdout.text()).toContain('Usage: aharness run ./workflow.fsm.ts --help\n');
    expect(stdout.text()).toContain('Target: ./workflow.fsm.ts\n');
    expect(stdout.text()).toContain('FSM: /repo/workflow.fsm.ts\n');
    expect(stdout.text()).toContain('Required input flags:\n');
    expect(stdout.text()).toContain('  --name <string> (string) - Run name\n');
    expect(stdout.text()).toContain('Optional input flags:\n');
    expect(stdout.text()).toContain('  none\n');
  });

  it('renders fixture-backed input metadata without importing the module', async () => {
    const stdout = makeWritableBuffer();
    const stderr = makeWritableBuffer();

    const result = await runLocalFsmInputHelpForTest({
      cwd: process.cwd(),
      target: typedFixture,
      usage: `aharness run ${typedFixture} --help`,
      stdout: stdout.sink,
      stderr: stderr.sink,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text()).toBe('');
    expect(stdout.text()).toContain(`Target: ${typedFixture}\n`);
    expect(stdout.text()).toContain(`FSM: ${resolve(process.cwd(), typedFixture)}\n`);
    expect(stdout.text()).toContain('Required input flags:\n');
    expect(stdout.text()).toContain('Optional input flags:\n');
    expect(stdout.text()).toContain('  --dry-run (boolean, default: false) - Skip execution\n');
    expect(stdout.text()).toContain('  --payload <value> (object) - JSON payload\n');
    expect(stdout.text()).toContain('  --topic <string> (string) - Project topic\n');
  });

  it('renders no declared inputs from the existing empty-input fixture', async () => {
    const stdout = makeWritableBuffer();
    const stderr = makeWritableBuffer();

    const result = await runLocalFsmInputHelpForTest({
      cwd: process.cwd(),
      target: emptyFixture,
      usage: `aharness run ${emptyFixture} --help`,
      stdout: stdout.sink,
      stderr: stderr.sink,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text()).toBe('');
    expect(stdout.text()).toContain('Inputs: none\n');
  });

  it('does not import an FSM while reading static input metadata', async () => {
    const stdout = makeWritableBuffer();
    const stderr = makeWritableBuffer();

    const result = await runLocalFsmInputHelpForTest({
      cwd: process.cwd(),
      target: throwsOnImportFixture,
      usage: `aharness run ${throwsOnImportFixture} --help`,
      stdout: stdout.sink,
      stderr: stderr.sink,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text()).toBe('');
    expect(stdout.text()).toContain('Required input flags:\n');
    expect(stdout.text()).toContain('  --safe <string> (string) - Static field\n');
  });

  it('returns non-zero and reports extraction failures', async () => {
    const stdout = makeWritableBuffer();
    const stderr = makeWritableBuffer();
    const extractSchemaSidecarImpl = vi.fn<typeof extractSchemaSidecar>(async () => {
      throw new Error('cannot parse fixture');
    });

    const result = await runLocalFsmInputHelpForTest({
      cwd: '/repo',
      target: 'bad.fsm.ts',
      usage: 'aharness run bad.fsm.ts --help',
      stdout: stdout.sink,
      stderr: stderr.sink,
      extractSchemaSidecarImpl,
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toBe(
      'aharness: failed to read FSM input metadata: cannot parse fixture\n',
    );
  });

  it('returns non-zero when schema metadata cannot describe a declared field', async () => {
    const stdout = makeWritableBuffer();
    const stderr = makeWritableBuffer();
    const extractSchemaSidecarImpl = vi.fn<typeof extractSchemaSidecar>(async () => ({
      sidecar: {},
      issues: [],
      inputSchema: {
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic'],
        additionalProperties: false,
      },
      inputFlags: {},
    }));

    const result = await runLocalFsmInputHelpForTest({
      cwd: '/repo',
      target: 'bad.fsm.ts',
      usage: 'aharness run bad.fsm.ts --help',
      stdout: stdout.sink,
      stderr: stderr.sink,
      extractSchemaSidecarImpl,
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toBe(
      'aharness: failed to read FSM input metadata: missing inputFlags metadata for field topic\n',
    );
  });

  it('returns non-zero when input flags are missing for a declared schema', async () => {
    const stdout = makeWritableBuffer();
    const stderr = makeWritableBuffer();
    const extractSchemaSidecarImpl = vi.fn<typeof extractSchemaSidecar>(async () => ({
      sidecar: {},
      issues: [],
      inputSchema: {
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic'],
        additionalProperties: false,
      },
    }));

    const result = await runLocalFsmInputHelpForTest({
      cwd: '/repo',
      target: 'bad.fsm.ts',
      usage: 'aharness run bad.fsm.ts --help',
      stdout: stdout.sink,
      stderr: stderr.sink,
      extractSchemaSidecarImpl,
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toBe(
      'aharness: failed to read FSM input metadata: missing inputFlags metadata\n',
    );
  });
});
