/**
 * Foreground-CLI signal handlers for `aharness <file>.fsm.ts`.
 *
 * Both SIGINT and SIGTERM are routed through the caller's `onSigint`
 * callback — the foreground CLI treats either as "user wants out" and
 * runs the §5.6 shutdown sequence. The returned handle's `close()` must
 * be called on every exit path so the listeners do not survive into a
 * subsequent test or embedding scenario.
 */

export interface SignalHandlersOpts {
  /** Invoked on SIGINT or SIGTERM. May be async; the return value is ignored. */
  readonly onSigint: () => void | Promise<void>;
}

export interface SignalHandlersHandle {
  /** Remove the SIGINT and SIGTERM listeners. Idempotent. */
  close(): void;
}

export function startSignalHandlers(o: SignalHandlersOpts): SignalHandlersHandle {
  let closed = false;
  const fire = (): void => {
    void o.onSigint();
  };
  process.on('SIGINT', fire);
  process.on('SIGTERM', fire);
  return {
    close(): void {
      if (closed) return;
      closed = true;
      process.off('SIGINT', fire);
      process.off('SIGTERM', fire);
    },
  };
}
