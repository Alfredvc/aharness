/**
 * Phase 1 stdout UI substitute. Subscribes to `item/agentMessage/delta`
 * notifications (text deltas) and emits a one-line ASCII log on every
 * FSM transition (called by the dispatcher after commit + flush).
 *
 * The TUI surface lands in a later phase; until then the headless CLI
 * streams model output and transition markers directly to stdout so the
 * user sees forward progress.
 */
export interface StdoutUIOpts {
  readonly stdout: NodeJS.WritableStream;
}

export interface StdoutUI {
  onAgentMessageDelta(params: { readonly delta?: string }): void;
  onTransition(info: { readonly from: string; readonly exit: string; readonly to: string }): void;
}

export function createStdoutUI(o: StdoutUIOpts): StdoutUI {
  return {
    onAgentMessageDelta(params) {
      if (typeof params.delta === 'string' && params.delta.length > 0) {
        o.stdout.write(params.delta);
      }
    },
    onTransition({ from, exit, to }) {
      o.stdout.write(`\n[transition] ${from} --${exit}--> ${to}\n`);
    },
  };
}
