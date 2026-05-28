/**
 * Minimal surface of `node:child_process.ChildProcess` that the
 * foreground CLI uses. Defined separately so `runCliForTest` callers
 * can provide stub objects without faking the full `ChildProcess`
 * surface (events, stdio, IPC, etc.).
 *
 * Keep this small — every method we add is one more thing every test
 * has to fake.
 */

export interface ChildProcessStdinLike {
  write(chunk: string): boolean;
}

export interface ChildProcessStdoutLike {
  setEncoding(encoding: BufferEncoding): void;
  on(event: 'data', listener: (chunk: string) => void): void;
}

export interface ChildProcessLike {
  /** `null` while running; numeric once the child has exited. */
  readonly exitCode: number | null;
  readonly stdin?: ChildProcessStdinLike | null;
  readonly stdout?: ChildProcessStdoutLike | null;
  /** Sends the named POSIX signal (`SIGTERM` / `SIGKILL`). */
  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean;
  /**
   * One-shot listener for the `exit` event. The signature mirrors
   * `ChildProcess.once('exit', …)` so a real `ChildProcess` is
   * structurally compatible without a cast.
   */
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}
