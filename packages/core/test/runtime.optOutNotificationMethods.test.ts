/**
 * Approval notification subscription audit for the initialize
 * `optOutNotificationMethods` capability.
 *
 * Pinned Codex commit `127434cd8b96` declares approval lifecycle
 * notifications in `codex-rs/app-server-protocol/src/protocol/common.rs`.
 * The aharness must not opt out of the notifications required to render and
 * clear browser approval cards.
 */
import { describe, expect, it } from 'vitest';

import { PHASE1_OPT_OUT_METHODS } from '../src/runtime/optOutNotificationMethods.js';
import { METHOD } from '../src/protocol/methodNames.js';

const REQUIRED_APPROVAL_LIFECYCLE_NOTIFICATIONS = [
  METHOD.fileChangePatchUpdated,
  METHOD.serverRequestResolved,
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
] as const;

const REQUIRED_RAW_RUNTIME_CAPTURE_NOTIFICATIONS = [
  METHOD.rawResponseItemCompleted,
  METHOD.threadTokenUsageUpdated,
] as const;

describe('approval notification opt-out list', () => {
  it('keeps required approval lifecycle notifications subscribed', () => {
    for (const method of REQUIRED_APPROVAL_LIFECYCLE_NOTIFICATIONS) {
      expect(PHASE1_OPT_OUT_METHODS).not.toContain(method);
    }
  });

  it('keeps Slice 2 raw runtime capture notifications subscribed', () => {
    for (const method of REQUIRED_RAW_RUNTIME_CAPTURE_NOTIFICATIONS) {
      expect(PHASE1_OPT_OUT_METHODS).not.toContain(method);
    }
  });
});
