import { describe, expect, it } from 'vitest';
import { createUiEventLog, serializeSseEvent, startUiServer } from '../src/runtime.js';
import type {
  AppEvent,
  ReplayableAppEvent,
  RunMeta,
  StartUiServerOptions,
  UiEventLog,
  UiServerHandle,
} from '../src/runtime.js';

describe('runtime UI exports', () => {
  it('exposes the Phase 3a UI event log and server API from the runtime barrel', () => {
    const run: RunMeta = {
      runId: 'run-1',
      threadId: 'thread-1',
      repoRoot: '/repo',
      fsmFile: 'agent.fsm.ts',
      fsmHash6: 'abc123',
      codexPin: 'codex-test',
      startedAt: '2026-05-13T00:00:00.000Z',
    };
    const event: AppEvent = {
      kind: 'FrameworkNote',
      id: 'note-1',
      text: 'browser UI substrate ready',
      variant: 'info',
    };

    const log: UiEventLog = createUiEventLog({ run });
    const published: ReplayableAppEvent = log.publish(event);
    const frame = serializeSseEvent(published);

    expect(published.id).toBe('1');
    expect(frame).toContain('event: FrameworkNote');
    expect(typeof startUiServer).toBe('function');

    const _serverOptions: StartUiServerOptions = {
      host: '127.0.0.1',
      port: 0,
      uiToken: 'test-ui-token',
      eventLog: log,
    };
    const _serverHandle: UiServerHandle | null = null;
    expect(_serverHandle).toBeNull();
  });
});
