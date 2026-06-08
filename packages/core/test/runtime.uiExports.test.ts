import { describe, expect, it } from 'vitest';
import {
  createUiEventLog,
  serializeSseEvent,
  startAharnessRun,
  startUiServer,
} from '../src/runtime.js';
import type {
  AharnessRunEvent,
  AharnessRunHandle,
  AharnessRunReplyResult,
  AharnessRunResult,
  StartAharnessRunOptions,
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
    expect(typeof startAharnessRun).toBe('function');

    const _serverOptions: StartUiServerOptions = {
      host: '127.0.0.1',
      port: 0,
      uiToken: 'test-ui-token',
      eventLog: log,
    };
    const _serverHandle: UiServerHandle | null = null;
    const _runOptions: StartAharnessRunOptions = {
      target: './demo.fsm.ts',
      input: {},
      ui: false,
    };
    const _runHandle: AharnessRunHandle | null = null;
    const _runEvent: AharnessRunEvent | null = null;
    const _sidecarRunEvent: AharnessRunEvent = {
      schema: 'aharness.event.v1',
      runId: 'run-1',
      seq: 2,
      id: 'run-1:2',
      time: '2026-06-08T00:00:00.000Z',
      type: 'sidecar.thread.started',
      threadId: 'sidecar-thread-1',
      data: { sidecar: true, sidecarKey: 'helper' },
      meta: { sidecar: true, sidecarKey: 'helper' },
    };
    const _replyResult: AharnessRunReplyResult | null = null;
    const _runResult: AharnessRunResult | null = null;
    expect(_serverHandle).toBeNull();
    expect(_runHandle).toBeNull();
    expect(_runEvent).toBeNull();
    expect(_sidecarRunEvent.type).toBe('sidecar.thread.started');
    expect(_replyResult).toBeNull();
    expect(_runResult).toBeNull();
  });
});
