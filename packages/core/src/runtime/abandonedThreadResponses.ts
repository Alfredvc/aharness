import type {
  CommandExecutionRequestApprovalResponse,
  DynamicToolCallResponse,
  FileChangeRequestApprovalResponse,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from '../protocol/types.js';

export const ABANDONED_THREAD_DYNAMIC_TOOL_MESSAGE =
  'harness: request belongs to an abandoned thread after clearOnEntry; ignored.';

export const DECLINED_ANSWER_TEXT = '(declined)';

/**
 * Shared abandoned-thread response builders. These helpers intentionally
 * do not emit diagnostic residue; Slice 5 owns that visible diagnostic UI.
 */
export function buildAbandonedDynamicToolCallResponse(): DynamicToolCallResponse {
  return {
    success: false,
    contentItems: [
      {
        type: 'inputText',
        text: ABANDONED_THREAD_DYNAMIC_TOOL_MESSAGE,
      },
    ],
  };
}

export function buildAbandonedToolRequestUserInputResponse(
  params: ToolRequestUserInputParams,
): ToolRequestUserInputResponse {
  return {
    answers: Object.fromEntries(
      params.questions.map((question) => [
        question.id,
        {
          answers: [DECLINED_ANSWER_TEXT],
        },
      ]),
    ),
  };
}

export function buildAbandonedCommandExecutionApprovalResponse(): CommandExecutionRequestApprovalResponse {
  return { decision: 'decline' };
}

export function buildAbandonedFileChangeApprovalResponse(): FileChangeRequestApprovalResponse {
  return { decision: 'decline' };
}

export function buildAbandonedPermissionsApprovalResponse(): PermissionsRequestApprovalResponse {
  return {
    permissions: {},
    scope: 'turn',
  };
}

export function buildAbandonedMcpServerElicitationResponse(): McpServerElicitationRequestResponse {
  return {
    action: 'cancel',
    content: null,
    _meta: null,
  };
}
