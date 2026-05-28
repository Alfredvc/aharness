# Design Conversation Guide

Use this guide only while the FSM is in `designConversation`.

## Context First

- Read relevant project files, docs, and recent work before asking detailed questions.
- If the topic spans multiple independent subsystems, flag that immediately and help narrow to one coherent design target.
- Follow existing project patterns unless the current work requires changing them.

## Clarify

- Ask one question at a time.
- Prefer multiple-choice questions when they reduce ambiguity.
- Focus on purpose, constraints, success criteria, users, data flow, failure handling, and testing expectations.
- If visual choices matter, offer the visual companion as its own message before visual exploration. Details live in `visual-companion.md`.

## Shape The Design

- Propose 2-3 approaches with trade-offs.
- Explain the recommended approach and why it fits the project context.
- Present the design in sections scaled to complexity: architecture, components, data flow, error handling, and testing.
- Ask for owner approval after the design is coherent enough to build from.

## Exit Discipline

- Submit `designReview` with `approved=true` only after explicit owner approval.
- Submit `approved=false` when the owner rejects or revises the design, and keep iterating in this state.
- Submit `blocked` only when required context or owner input is unavailable.
