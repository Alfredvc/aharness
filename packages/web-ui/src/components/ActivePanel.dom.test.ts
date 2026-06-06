// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolCallRow } from './ActivePanel.js';
import type { TranscriptItem } from '../state/store.js';

const pendingTool: Extract<TranscriptItem, { type: 'tool_call' }> = {
  id: 'pending-tool',
  type: 'tool_call',
  name: 'bash',
  preview: 'pnpm test',
  status: 'pending',
  reserved: false,
  stateVisitId: 'workflow.collect#1',
};

function toolCallRowForTest(item: Extract<TranscriptItem, { type: 'tool_call' }>) {
  return createElement(ToolCallRow, { item });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ActivePanel DOM effects', () => {
  it('cleans up the pending tool timer when status changes', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const intervalId = 1234;
    const setIntervalSpy = vi
      .spyOn(window, 'setInterval')
      .mockImplementation(() => intervalId as unknown as ReturnType<typeof window.setInterval>);
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);

    act(() => {
      root.render(createElement(() => toolCallRowForTest(pendingTool)));
    });

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        createElement(() =>
          toolCallRowForTest({
            ...pendingTool,
            status: 'completed',
            elapsedMs: 1000,
          }),
        ),
      );
    });

    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);

    act(() => {
      root.unmount();
    });
  });
});
