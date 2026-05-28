import { describe, expect, it, vi } from 'vitest';
import type { ToolRequestUserInputParams } from '../src/protocol/types.js';
import { createBrowserReplyController } from '../src/ui/reply.js';

function ownerInputParams(
  overrides: Partial<ToolRequestUserInputParams> = {},
): ToolRequestUserInputParams {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    questions: [
      {
        id: 'q1',
        header: 'First',
        question: 'First answer?',
        isOther: false,
        isSecret: false,
      },
      {
        id: 'q2',
        header: 'Second',
        question: 'Second answer?',
        isOther: false,
        isSecret: true,
      },
    ],
    ...overrides,
  };
}

describe('createBrowserReplyController', () => {
  it('parks one owner-input request and resolves it with codex answer wire shape', async () => {
    const onOwnerInputAccepted = vi.fn();
    const controller = createBrowserReplyController({
      isOpen: () => false,
      sendUserPrompt: vi.fn(),
      onOwnerInputAccepted,
    });
    const parked = controller.parkOwnerInput(ownerInputParams());

    const result = await controller.handleReply({
      kind: 'owner-input',
      requestId: 'item-1',
      answers: { q1: 'alpha', q2: 'bravo' },
    });

    expect(result.status).toBe(200);
    await expect(parked).resolves.toEqual({
      answers: {
        q1: { answers: ['alpha'] },
        q2: { answers: ['bravo'] },
      },
    });
    expect(onOwnerInputAccepted).toHaveBeenCalledExactlyOnceWith('item-1');
  });

  it('rejects wrong requestId values without consuming the parked owner request', async () => {
    const controller = createBrowserReplyController({
      isOpen: () => false,
      sendUserPrompt: vi.fn(),
    });
    const parked = controller.parkOwnerInput(ownerInputParams());

    const result = await controller.handleReply({
      kind: 'owner-input',
      requestId: 'item-2',
      answers: { q1: 'alpha', q2: 'bravo' },
    });

    expect(result.status).toBe(409);

    const accepted = await controller.handleReply({
      kind: 'owner-input',
      requestId: 'item-1',
      answers: { q1: 'alpha', q2: 'bravo' },
    });

    expect(accepted.status).toBe(200);
    await expect(parked).resolves.toEqual({
      answers: {
        q1: { answers: ['alpha'] },
        q2: { answers: ['bravo'] },
      },
    });
  });

  it('rejects duplicate owner replies after a request has resolved', async () => {
    const controller = createBrowserReplyController({
      isOpen: () => false,
      sendUserPrompt: vi.fn(),
    });

    const parked = controller.parkOwnerInput(ownerInputParams());
    await controller.handleReply({
      kind: 'owner-input',
      requestId: 'item-1',
      answers: { q1: 'alpha', q2: 'bravo' },
    });
    await parked;

    const duplicate = await controller.handleReply({
      kind: 'owner-input',
      requestId: 'item-1',
      answers: { q1: 'alpha', q2: 'bravo' },
    });

    expect(duplicate.status).toBe(409);
  });

  it('rejects owner-input replies that omit any requested question answer', async () => {
    const controller = createBrowserReplyController({
      isOpen: () => false,
      sendUserPrompt: vi.fn(),
    });

    controller.parkOwnerInput(ownerInputParams());

    const result = await controller.handleReply({
      kind: 'owner-input',
      requestId: 'item-1',
      answers: { q1: 'alpha' },
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: 'missing-owner-input-answer',
      missingQuestionIds: ['q2'],
    });
  });

  it('resolves abandoned owner-input requests with synthetic declined answers', async () => {
    const onOwnerInputResolved = vi.fn();
    const onAbandonedThreadDiagnostic = vi.fn();
    const controller = createBrowserReplyController({
      isOpen: () => false,
      sendUserPrompt: vi.fn(),
      isAbandonedThread: (threadId) => threadId === 'thread-old',
      onOwnerInputResolved,
      onAbandonedThreadDiagnostic,
    });

    const parked = controller.parkOwnerInput(ownerInputParams({ threadId: 'thread-old' }));

    controller.abandonInactiveOwnerInput();
    controller.abandonInactiveOwnerInput();

    await expect(parked).resolves.toEqual({
      answers: {
        q1: { answers: ['(declined)'] },
        q2: { answers: ['(declined)'] },
      },
    });
    expect(onOwnerInputResolved).toHaveBeenCalledExactlyOnceWith('item-1');
    expect(onAbandonedThreadDiagnostic).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ threadId: 'thread-old', source: 'parkedOwnerInput' }),
    );

    const staleReply = await controller.handleReply({
      kind: 'owner-input',
      requestId: 'item-1',
      answers: { q1: 'alpha', q2: 'bravo' },
    });

    expect(staleReply).toEqual({
      status: 409,
      body: { error: 'no-pending-owner-input' },
    });
  });

  it('leaves current-thread owner-input requests pending during cleanup', async () => {
    const controller = createBrowserReplyController({
      isOpen: () => false,
      sendUserPrompt: vi.fn(),
      isAbandonedThread: (threadId) => threadId === 'thread-old',
    });

    const parked = controller.parkOwnerInput(ownerInputParams({ threadId: 'thread-current' }));

    controller.abandonInactiveOwnerInput();

    const result = await controller.handleReply({
      kind: 'owner-input',
      requestId: 'item-1',
      answers: { q1: 'alpha', q2: 'bravo' },
    });

    expect(result.status).toBe(200);
    await expect(parked).resolves.toEqual({
      answers: {
        q1: { answers: ['alpha'] },
        q2: { answers: ['bravo'] },
      },
    });
  });

  it('sends user-prompt replies exactly once when the active posture is open', async () => {
    const sendUserPrompt = vi.fn();
    const controller = createBrowserReplyController({
      isOpen: () => true,
      sendUserPrompt,
    });

    const result = await controller.handleReply({ kind: 'user-prompt', text: 'continue' });

    expect(result.status).toBe(200);
    expect(sendUserPrompt).toHaveBeenCalledExactlyOnceWith('continue');
  });

  it('rejects user-prompt replies while the active posture is closed', async () => {
    const sendUserPrompt = vi.fn();
    const controller = createBrowserReplyController({
      isOpen: () => false,
      sendUserPrompt,
    });

    const result = await controller.handleReply({ kind: 'user-prompt', text: 'continue' });

    expect(result.status).toBe(409);
    expect(sendUserPrompt).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'approval', requestId: 'approval-1', decision: 'accept' }],
    [{ kind: 'permission', requestId: 'permission-1', decision: 'accept' }],
    [{ kind: 'elicitation', requestId: 'elicitation-1', action: 'accept', values: {} }],
  ])('delegates Phase 4 approval replies when a handler is provided: %o', async (payload) => {
    const sendUserPrompt = vi.fn();
    const handleApprovalReply = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    const controller = createBrowserReplyController({
      isOpen: () => true,
      sendUserPrompt,
      handleApprovalReply,
    });

    const result = await controller.handleReply(payload);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(handleApprovalReply).toHaveBeenCalledExactlyOnceWith(payload);
    expect(sendUserPrompt).not.toHaveBeenCalled();
  });

  it('keeps approval replies unavailable until the runtime wires a handler', async () => {
    const controller = createBrowserReplyController({
      isOpen: () => true,
      sendUserPrompt: vi.fn(),
    });

    const result = await controller.handleReply({
      kind: 'approval',
      requestId: 'approval-1',
      decision: 'accept',
    });

    expect(result.status).toBe(501);
    expect(result.body).toEqual({ error: 'reply-kind-unavailable' });
  });
});
