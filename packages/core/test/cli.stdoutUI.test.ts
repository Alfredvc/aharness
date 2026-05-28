import { describe, it, expect } from 'vitest';

import { createStdoutUI } from '../src/cli/stdoutUI.js';

describe('stdoutUI', () => {
  it('writes agentMessage deltas verbatim to stdout', () => {
    const out: string[] = [];
    const stream = {
      write: (s: string) => {
        out.push(s);
        return true;
      },
    } as NodeJS.WritableStream;
    const ui = createStdoutUI({ stdout: stream });
    ui.onAgentMessageDelta({ delta: 'hello ' });
    ui.onAgentMessageDelta({ delta: 'world' });
    expect(out.join('')).toBe('hello world');
  });

  it('writes a transition log line', () => {
    const out: string[] = [];
    const stream = {
      write: (s: string) => {
        out.push(s);
        return true;
      },
    } as NodeJS.WritableStream;
    const ui = createStdoutUI({ stdout: stream });
    ui.onTransition({ from: 'a', exit: 'go', to: 'b' });
    expect(out.join('')).toContain('[transition] a --go--> b');
  });

  it('ignores empty/missing deltas', () => {
    const out: string[] = [];
    const stream = {
      write: (s: string) => {
        out.push(s);
        return true;
      },
    } as NodeJS.WritableStream;
    const ui = createStdoutUI({ stdout: stream });
    ui.onAgentMessageDelta({});
    ui.onAgentMessageDelta({ delta: '' });
    expect(out).toEqual([]);
  });
});
