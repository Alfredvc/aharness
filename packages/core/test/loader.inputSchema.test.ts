import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { extractSchemaSidecar } from '../src/loader/sidecar.js';

const fixture = path.resolve(__dirname, 'fixtures/args/typed-input.fsm.ts');
const createFsmFixtures = path.resolve(__dirname, 'fixtures/create-fsm');

describe('loader — input schema extraction', () => {
  it('emits a per-field JSON schema for each arg<T>()', async () => {
    const { inputSchema } = await extractSchemaSidecar({ filePath: fixture });
    expect(inputSchema).toBeDefined();
    expect(inputSchema!.type).toBe('object');
    const props = inputSchema!.properties as Record<string, { type?: string }>;
    expect(props.ideafilePath?.type).toBe('string');
    expect(props.topic?.type).toBe('string');
    expect(props.runs?.type).toBe('number');
    expect(props.choice?.type).toBe('object');
  });

  it('marks fields without a default as required', () => {
    return extractSchemaSidecar({ filePath: fixture }).then(({ inputSchema }) => {
      expect((inputSchema!.required as string[]).sort()).toEqual([
        'choice',
        'ideafilePath',
        'topic',
      ]);
    });
  });

  it('captures arg meta per field', async () => {
    const { inputFlags } = await extractSchemaSidecar({ filePath: fixture });
    expect(inputFlags!.ideafilePath.description).toBe('Path to ideafile');
    expect(inputFlags!.ideafilePath.completion).toBe('file');
    expect(inputFlags!.runs.default).toBe(3);
    expect(inputFlags!.choice.completion).toEqual({ values: ['a', 'b', 'c'] });
  });

  it('emits an empty object schema when input: {} is declared', async () => {
    const emptyFixture = path.resolve(__dirname, 'fixtures/args/empty-input.fsm.ts');
    const { inputSchema, inputFlags } = await extractSchemaSidecar({ filePath: emptyFixture });
    expect(inputSchema).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(inputFlags).toEqual({});
  });

  it('extracts schemas for canonical fsm.input.* helpers', async () => {
    const { inputSchema, inputFlags } = await extractSchemaSidecar({
      filePath: path.join(createFsmFixtures, 'input-skills-passive.fsm.ts'),
    });
    expect(inputSchema).toBeDefined();
    const props = inputSchema!.properties as Record<string, { type?: string }>;
    expect(props.topic?.type).toBe('string');
    expect(props.rounds?.type).toBe('number');
    expect(props.specPath?.type).toBe('string');
    expect(inputSchema!.required).toEqual(['topic', 'specPath']);
    expect(inputFlags!.topic.description).toBe('Project topic');
    expect(inputFlags!.topic.completion).toEqual({ values: ['auth', 'billing'] });
    expect(inputFlags!.rounds.default).toBe(3);
    expect(inputFlags!.specPath.completion).toBe('file');
  });

  it('extracts canonical fsm.submit<T>() schemas for direct and routed submits', async () => {
    const { sidecar } = await extractSchemaSidecar({
      filePath: path.join(createFsmFixtures, 'color-funnel.fsm.ts'),
    });
    expect(sidecar.pickColor?.submit).toBeUndefined();
    expect(sidecar.confirm?.submit).toBeUndefined();
    expect(sidecar.pickRedFruit?.submit?.jsonSchema).toMatchObject({
      type: 'object',
      properties: { fruit: { type: 'string' }, reason: { type: 'string' } },
    });
    expect(sidecar.resetFruit?.submit?.jsonSchema).toMatchObject({
      type: 'object',
      properties: { color: { enum: ['red', 'green'] } },
    });
  });

  it('does not treat canonical hook event object handlers as submit exits', async () => {
    const { sidecar, issues } = await extractSchemaSidecar({
      filePath: path.join(createFsmFixtures, 'canonical-hook-event.fsm.ts'),
    });

    expect(issues).toEqual([]);
    expect(sidecar.review?.submit?.jsonSchema).toMatchObject({
      type: 'object',
      properties: { done: { type: 'boolean' } },
    });
    expect(sidecar.review?.permissionRequest).toBeUndefined();
  });

  it('recognizes factories returned from withEvents() for source extraction', async () => {
    const { sidecar, inputSchema, inputFlags, issues } = await extractSchemaSidecar({
      filePath: path.join(createFsmFixtures, 'canonical-with-events.fsm.ts'),
    });

    expect(issues).toEqual([]);
    expect(inputSchema).toBeDefined();
    expect(inputSchema!.properties).toMatchObject({
      topic: { type: 'string' },
    });
    expect(inputFlags!.topic.description).toBe('Work topic');
    expect(sidecar.review?.submit?.jsonSchema).toMatchObject({
      type: 'object',
      properties: { accepted: { type: 'boolean' } },
    });
    expect(sidecar.review?.testsFinished).toBeUndefined();
  });

  it('recognizes chained createFsm().withEvents() factories for source extraction', async () => {
    const { sidecar, inputSchema, inputFlags, issues } = await extractSchemaSidecar({
      filePath: path.join(createFsmFixtures, 'canonical-with-events-chained.fsm.ts'),
    });

    expect(issues).toEqual([]);
    expect(inputSchema).toBeDefined();
    expect(inputSchema!.properties).toMatchObject({
      topic: { type: 'string' },
    });
    expect(inputFlags!.topic.description).toBe('Chained topic');
    expect(sidecar.review?.submit?.jsonSchema).toMatchObject({
      type: 'object',
      properties: { accepted: { type: 'boolean' } },
    });
    expect(sidecar.review?.testsFinished).toBeUndefined();
  });
});
