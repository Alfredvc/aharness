import { describe, expectTypeOf, it } from 'vitest';
import { createFsm, final, terminal } from '../src/index.js';

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
