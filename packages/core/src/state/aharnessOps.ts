/**
 * `AharnessOps` is the reserved closed-world operations facade passed to
 * author callbacks. Fresh clear is declarative state metadata
 * (`clearOnEntry`), so the runtime object intentionally exposes no
 * imperative clear capability.
 */
export type AharnessOps = Readonly<Record<string, never>>;

export interface AharnessOpsHandle {
  readonly ops: AharnessOps;
}

const EMPTY_OPS: AharnessOps = Object.freeze({});

export function createAharnessOps(): AharnessOpsHandle {
  return {
    ops: EMPTY_OPS,
  };
}
