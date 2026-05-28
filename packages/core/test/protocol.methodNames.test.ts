/**
 * Pins each verified wire-method literal in `METHOD`. An accidental edit
 * (e.g. dropping the `item/` namespace prefix from `item/tool/call`)
 * fails this test loudly; an intentional bump of the codex pin must
 * update both the literal and this assertion together.
 *
 * Source: `packages/core/src/protocol/methodNames.ts` carries the
 * file:line citation against codex-rs at the pinned commit
 * (`SUPPORTED_CODEX.md`).
 */

import { describe, expect, it } from 'vitest';
import { METHOD } from '../src/protocol/methodNames.js';

describe('METHOD wire literals', () => {
  // Each row is the property name → exact wire literal expected at the
  // pinned codex commit. Keep this table in sync with R18's verification
  // table in `SUPPORTED_CODEX.md`.
  const expected: Record<keyof typeof METHOD, string> = {
    initialize: 'initialize',
    threadStart: 'thread/start',
    threadResume: 'thread/resume',
    threadRollback: 'thread/rollback',
    threadInjectItems: 'thread/inject_items',
    threadNameSet: 'thread/name/set',
    threadUnsubscribe: 'thread/unsubscribe',
    turnStart: 'turn/start',
    turnInterrupt: 'turn/interrupt',
    commandExecutionRequestApproval: 'item/commandExecution/requestApproval',
    fileChangeRequestApproval: 'item/fileChange/requestApproval',
    toolDynamicCall: 'item/tool/call',
    toolRequestUserInput: 'item/tool/requestUserInput',
    mcpServerElicitationRequest: 'mcpServer/elicitation/request',
    permissionsRequestApproval: 'item/permissions/requestApproval',
    threadStarted: 'thread/started',
    turnStarted: 'turn/started',
    turnCompleted: 'turn/completed',
    itemStarted: 'item/started',
    itemCompleted: 'item/completed',
    fileChangePatchUpdated: 'item/fileChange/patchUpdated',
    serverRequestResolved: 'serverRequest/resolved',
    hookStarted: 'hook/started',
    hookCompleted: 'hook/completed',
    agentMessageDelta: 'item/agentMessage/delta',
    rawResponseItemCompleted: 'rawResponseItem/completed',
    threadTokenUsageUpdated: 'thread/tokenUsage/updated',
    mcpServerStatusList: 'mcpServerStatus/list',
  };

  for (const [key, literal] of Object.entries(expected) as Array<[keyof typeof METHOD, string]>) {
    it(`METHOD.${String(key)} === ${JSON.stringify(literal)}`, () => {
      expect(METHOD[key]).toBe(literal);
    });
  }

  it('exposes turn/interrupt with the codex wire literal', () => {
    expect(METHOD.turnInterrupt).toBe('turn/interrupt');
  });

  it('exposes thread/rollback with the codex wire literal', () => {
    expect(METHOD.threadRollback).toBe('thread/rollback');
  });

  it('does not export turnAborted (no such notification in codex v2)', () => {
    // Spec §1.6: codex's v2 ServerNotification enum has no `turn/aborted`
    // literal. The cross-state path awaits turn/interrupt resolution
    // directly instead. If a future codex release adds turn/aborted, the
    // METHOD addition is gated on a separate spec revision; this test
    // is the canary.
    expect((METHOD as { turnAborted?: unknown }).turnAborted).toBeUndefined();
  });

  it('does not export `threadSubscribe` (subscription is implicit)', () => {
    expect(Object.prototype.hasOwnProperty.call(METHOD, 'threadSubscribe')).toBe(false);
  });

  it('exposes thread/unsubscribe with the codex wire literal', () => {
    expect(METHOD.threadUnsubscribe).toBe('thread/unsubscribe');
  });

  it('does not export an `error` method (errors flow via JSON-RPC error envelopes)', () => {
    expect(Object.prototype.hasOwnProperty.call(METHOD, 'error')).toBe(false);
  });

  it('every entry is non-empty and namespaced', () => {
    for (const [key, value] of Object.entries(METHOD)) {
      expect(value.length).toBeGreaterThan(0);
      // `initialize` is the only un-namespaced wire literal; everything
      // else uses a `<namespace>/<rest>` shape.
      if (key !== 'initialize') {
        expect(value).toMatch(/\//);
      }
    }
  });
});
