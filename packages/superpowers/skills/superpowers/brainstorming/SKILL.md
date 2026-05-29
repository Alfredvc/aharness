---
name: brainstorming
description: Use when exploring an idea into an approved design before implementation; prefer the aharness run brainstorming FSM command when Harness is available.
---

# Brainstorming

This skill has been converted into the `aharness run brainstorming` Harness FSM command.

Use the FSM command when available. The FSM enforces the workflow gates: design conversation, owner design approval, spec writing, spec self-review, and owner spec approval.

## FSM State Map

- `designConversation`: explore project context, ask clarifying questions, compare approaches, and get owner approval for the design. Detailed guidance: `guides/design-conversation.md`.
- `writeAndReviewSpec`: write the approved design spec and self-review it before owner review. Detailed guidance: `guides/write-and-review-spec.md`.
- `ownerSpecApprovalGate`: ask the owner to approve the written spec or request concrete changes.

## Direct Skill Fallback

If Harness is not available, follow the same phases manually:

1. Explore project context.
2. Ask one clarifying question at a time.
3. Present 2-3 approaches with trade-offs.
4. Get explicit owner approval for the design.
5. Write the spec.
6. Self-review the spec for placeholders, contradictions, ambiguity, and scope drift.
7. Ask the owner to review the written spec before planning.

Keep process control in the FSM when using Harness. Use the guides only for phase-level operating guidance.
