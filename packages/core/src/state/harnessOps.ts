/**
 * `HarnessOps` is the reserved closed-world operations facade passed to
 * author callbacks. Fresh clear is declarative state metadata
 * (`clearOnEntry`), so the runtime object intentionally exposes no
 * imperative clear capability.
 */
export type HarnessOps = Readonly<Record<string, never>>;

export interface HarnessOpsHandle {
  readonly ops: HarnessOps;
}

const EMPTY_OPS: HarnessOps = Object.freeze({});

export function createHarnessOps(): HarnessOpsHandle {
  return {
    ops: EMPTY_OPS,
  };
}
