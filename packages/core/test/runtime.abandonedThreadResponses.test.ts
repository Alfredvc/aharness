import { describe, expect, it } from 'vitest';

import {
  ABANDONED_THREAD_DYNAMIC_TOOL_MESSAGE,
  DECLINED_ANSWER_TEXT,
  buildAbandonedCommandExecutionApprovalResponse,
  buildAbandonedDynamicToolCallResponse,
  buildAbandonedFileChangeApprovalResponse,
  buildAbandonedMcpServerElicitationResponse,
  buildAbandonedPermissionsApprovalResponse,
  buildAbandonedToolRequestUserInputResponse,
} from '../src/runtime/abandonedThreadResponses.js';
import type { ToolRequestUserInputParams } from '../src/protocol/types.js';

function ownerInputParams(): ToolRequestUserInputParams {
  return {
    threadId: 'old-thread',
    turnId: 'turn-1',
    itemId: 'item-1',
    questions: [
      {
        id: 'first',
        header: 'First',
        question: 'First question?',
        isOther: false,
        isSecret: false,
      },
      {
        id: 'second',
        header: 'Second',
        question: 'Second question?',
        isOther: false,
        isSecret: true,
      },
    ],
  };
}

describe('abandoned-thread response helpers', () => {
  it('pins the abandoned dynamic-tool response message and shape', () => {
    expect(ABANDONED_THREAD_DYNAMIC_TOOL_MESSAGE).toBe(
      'harness: request belongs to an abandoned thread after clearOnEntry; ignored.',
    );
    expect(buildAbandonedDynamicToolCallResponse()).toEqual({
      success: false,
      contentItems: [
        {
          type: 'inputText',
          text: ABANDONED_THREAD_DYNAMIC_TOOL_MESSAGE,
        },
      ],
    });
  });

  it('declines every parsed owner-input question with the shared decline text', () => {
    expect(DECLINED_ANSWER_TEXT).toBe('(declined)');
    expect(buildAbandonedToolRequestUserInputResponse(ownerInputParams())).toEqual({
      answers: {
        first: { answers: ['(declined)'] },
        second: { answers: ['(declined)'] },
      },
    });
  });

  it('builds the command and file approval decline responses', () => {
    expect(buildAbandonedCommandExecutionApprovalResponse()).toEqual({
      decision: 'decline',
    });
    expect(buildAbandonedFileChangeApprovalResponse()).toEqual({
      decision: 'decline',
    });
  });

  it('builds the permission approval turn-scope empty grant response', () => {
    expect(buildAbandonedPermissionsApprovalResponse()).toEqual({
      permissions: {},
      scope: 'turn',
    });
  });

  it('builds the MCP elicitation cancel response', () => {
    expect(buildAbandonedMcpServerElicitationResponse()).toEqual({
      action: 'cancel',
      content: null,
      _meta: null,
    });
  });
});
