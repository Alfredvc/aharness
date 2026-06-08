import type {
  CodexSidecarOps,
  CodexSidecarThread,
  CodexSidecarThreadOptions,
} from './codexSidecar.js';

export interface AharnessEmitResult {
  readonly handled: boolean;
  readonly stateChanged: boolean;
  readonly returnValue: unknown;
}

export type AharnessEmit = <Payload>(
  eventName: string,
  payload: Payload,
) => Promise<AharnessEmitResult>;

/**
 * `AharnessOps` is the closed-world operations facade passed to author
 * callbacks. Preflight and dry-run contexts receive the same shape as live
 * runs, but each operation throws if the live runtime has not bound it.
 */
export interface AharnessOps {
  readonly codex: CodexSidecarOps;
  readonly emit: AharnessEmit;
}

export interface AharnessOpsBindings {
  readonly codex?: CodexSidecarOps;
  readonly emit?: AharnessEmit;
}

export interface AharnessOpsHandle {
  readonly ops: AharnessOps;
  bind(bindings: AharnessOpsBindings): void;
}

function unavailableOperation(name: string): Error {
  return new Error(
    `Aharness ops.${name} is only available during a live run after the runtime binds operations`,
  );
}

export function createAharnessOps(initialBindings: AharnessOpsBindings = {}): AharnessOpsHandle {
  const bindings: { codex?: CodexSidecarOps; emit?: AharnessEmit } = {};
  if (initialBindings.codex !== undefined) {
    bindings.codex = initialBindings.codex;
  }
  if (initialBindings.emit !== undefined) {
    bindings.emit = initialBindings.emit;
  }
  const codex: CodexSidecarOps = Object.freeze({
    async createThread<Data = unknown>(
      key: string,
      options?: CodexSidecarThreadOptions<Data>,
    ): Promise<CodexSidecarThread> {
      const bound = bindings.codex;
      if (bound === undefined) {
        throw unavailableOperation('codex.createThread');
      }
      return bound.createThread(key, options);
    },
    thread(key: string): CodexSidecarThread {
      const bound = bindings.codex;
      if (bound === undefined) {
        throw unavailableOperation('codex.thread');
      }
      return bound.thread(key);
    },
  });
  const emit: AharnessEmit = async <Payload>(
    eventName: string,
    payload: Payload,
  ): Promise<AharnessEmitResult> => {
    const bound = bindings.emit;
    if (bound === undefined) {
      throw unavailableOperation('emit');
    }
    return bound(eventName, payload);
  };
  const ops: AharnessOps = Object.freeze({
    codex,
    emit,
  });
  return {
    ops,
    bind(nextBindings) {
      if (nextBindings.codex !== undefined) {
        bindings.codex = nextBindings.codex;
      }
      if (nextBindings.emit !== undefined) {
        bindings.emit = nextBindings.emit;
      }
    },
  };
}
