import { describe, expectTypeOf, it } from 'vitest';
import {
  CODEX_SIDECAR_DEFAULT_TURN_TIMEOUT_MS,
  CodexSidecarError,
  createFsm,
  final,
  terminal,
  type AharnessEmit,
  type AharnessOps,
  type CodexSidecarBoundary,
  type CodexSidecarBoundaryResult,
  type CodexSidecarFailureReason,
  type CodexSidecarInput,
  type CodexSidecarInputRequest,
  type CodexSidecarInstructionOptions,
  type CodexSidecarModelOptions,
  type CodexSidecarOps,
  type CodexSidecarThreadOptions,
} from '../src/index.js';

describe('terminal outcome author primitive types', () => {
  it('accepts only the closed terminal outcome union', () => {
    const terminalSuccess = terminal('success');
    const terminalFailure = terminal('failure');

    expectTypeOf(terminalSuccess.meta.aharness.outcome).toEqualTypeOf<'success' | 'failure'>();
    expectTypeOf(terminalFailure.meta.aharness.outcome).toEqualTypeOf<'success' | 'failure'>();

    final({ outcome: 'success' });
    final({ outcome: 'failure' });

    const fsm = createFsm<Record<string, never>>();
    fsm.final({ outcome: 'success' });
    fsm.final({ outcome: 'failure' });

    if (false) {
      // @ts-expect-error terminal() accepts only success or failure outcomes.
      terminal('skipped');

      // @ts-expect-error final() accepts only success or failure outcomes.
      final({ outcome: 'skipped' });

      // @ts-expect-error createFsm().final() accepts only success or failure outcomes.
      fsm.final({ outcome: 'skipped' });
    }
  });
});

describe('sidecar author primitive types', () => {
  it('exports the ops facade and sidecar create options from the root author surface', () => {
    expectTypeOf<AharnessOps>().toHaveProperty('codex').toEqualTypeOf<CodexSidecarOps>();
    expectTypeOf<AharnessOps>().toHaveProperty('emit').toEqualTypeOf<AharnessEmit>();
    expectTypeOf<typeof CODEX_SIDECAR_DEFAULT_TURN_TIMEOUT_MS>().toEqualTypeOf<120_000>();
    expectTypeOf<ConstructorParameters<typeof CodexSidecarError>>().toEqualTypeOf<
      [Extract<CodexSidecarBoundaryResult, { ok: false }>]
    >();

    type Data = { readonly fixtureRoot: string };
    const options: CodexSidecarThreadOptions<Data> = {
      cwd: (data) => data.fixtureRoot,
      initialSkills: ['subjectHelper'],
      defaultTurnTimeoutMs: 120_000,
      model: { name: 'gpt-5.1-codex', effort: 'high' },
      instructions: {
        base: 'Use the sidecar base instructions.',
        developer: 'Stay inside the fixture.',
      },
      label: 'Subject',
    };

    expectTypeOf(options.cwd).toEqualTypeOf<
      string | ((data: Readonly<Data>) => string) | undefined
    >();
    expectTypeOf(options.initialSkills).toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf(options.defaultTurnTimeoutMs).toEqualTypeOf<number | undefined>();
    expectTypeOf(options.model).toEqualTypeOf<CodexSidecarModelOptions | undefined>();
    expectTypeOf(options.instructions).toEqualTypeOf<CodexSidecarInstructionOptions | undefined>();
    expectTypeOf(options.label).toEqualTypeOf<string | undefined>();
  });

  it('keeps public sidecar send inputs closed', () => {
    const inputs = [
      { type: 'text', text: 'Inspect the fixture.' },
      { type: 'image', url: 'https://example.test/screenshot.png', detail: 'high' },
      { type: 'localImage', path: './screenshot.png', detail: 'auto' },
      { type: 'mention', name: 'README.md', path: './README.md' },
    ] as const satisfies readonly CodexSidecarInput[];

    expectTypeOf<(typeof inputs)[number]>().toMatchTypeOf<CodexSidecarInput>();

    if (false) {
      const rawSkillInput: CodexSidecarInput = {
        // @ts-expect-error public sidecar sends do not accept raw skill items; use initialSkills.
        type: 'skill',
        name: 'subject-helper',
        path: '/tmp/subject-helper/SKILL.md',
      };
      void rawSkillInput;
    }
  });

  it('supports discriminating sidecar boundary results', () => {
    function inspect(result: CodexSidecarBoundaryResult): CodexSidecarFailureReason | string {
      if (result.ok) {
        expectTypeOf(result).toEqualTypeOf<CodexSidecarBoundary>();
        if (result.kind === 'completed') {
          expectTypeOf(result.turn.assistantText).toEqualTypeOf<string>();
          return result.turn.assistantText;
        }
        expectTypeOf(result.request).toEqualTypeOf<CodexSidecarInputRequest>();
        return result.request.id;
      }

      expectTypeOf(result.reason).toEqualTypeOf<CodexSidecarFailureReason>();
      return result.reason;
    }

    expectTypeOf(inspect).returns.toEqualTypeOf<string>();
  });
});
