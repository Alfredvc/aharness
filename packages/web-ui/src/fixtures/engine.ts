// Fixture engine: plays a sequence of "scenes" of timed AppEvents. Each scene
// either awaits a reply (approval or owner-input), auto-advances after its
// frames drain, or simply terminates (no auto-advance, no awaits).

import type { AppEvent } from '../types/events.js';
import type { Scene } from './script.js';

type Listener = (e: AppEvent) => void;

// ReplyPayload mirrors the browser reply payload shape. Production wiring
// sends it through the run-scoped reply route; fixtures use the same payload
// so design work translates to the live UI.
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export type ReplyPayload =
  | { kind: 'owner-input'; requestId: string; answers: Record<string, string> }
  | { kind: 'approval'; requestId: string; decision: ApprovalDecision }
  | { kind: 'permission'; requestId: string; decision: 'accept' | 'decline' }
  | {
      kind: 'elicitation';
      requestId: string;
      action: 'accept' | 'decline' | 'cancel';
      content?: unknown;
    }
  | { kind: 'user-prompt'; text: string };

export type Engine = {
  subscribe(fn: Listener): () => void;
  start(): void;
  reply(payload: ReplyPayload): void;
  reset(): void;
};

export function createEngine(scenes: Scene[]): Engine {
  const listeners = new Set<Listener>();
  let timers: ReturnType<typeof setTimeout>[] = [];
  let started = false;
  let cursor = 0;

  function emit(e: AppEvent) {
    listeners.forEach((fn) => fn(e));
  }

  function playScene(scene: Scene) {
    let totalDelay = 0;
    for (const frame of scene.frames) {
      totalDelay += frame.at;
      const at = totalDelay;
      const t = setTimeout(() => emit(frame.event), at);
      timers.push(t);
    }
    if (scene.autoAdvance) {
      const gap = scene.autoAdvance.gapMs ?? 600;
      const t = setTimeout(() => {
        const next = scene.autoAdvance!.next?.(cursor) ?? cursor + 1;
        advance(next);
      }, totalDelay + gap);
      timers.push(t);
    }
  }

  function advance(picked?: number) {
    if (typeof picked === 'number') cursor = picked;
    else cursor += 1;
    const scene = scenes[cursor];
    if (!scene) return;
    playScene(scene);
  }

  function cancel() {
    timers.forEach((t) => clearTimeout(t));
    timers = [];
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      if (started) return;
      started = true;
      cursor = 0;
      const first = scenes[0];
      if (first) playScene(first);
    },
    reply(payload) {
      if (payload.kind === 'user-prompt') {
        // Free-text from an `open: true` state. Echo into transcript; no
        // scene advance — open-state user prompts open a fresh turn under
        // the production CLI but fixtures don't model that path yet.
        emit({
          kind: 'ItemStarted',
          id: `item-prompt-${Date.now()}`,
          type: 'user_message',
          text: payload.text,
        });
        return;
      }
      const scene = scenes[cursor];
      if (!scene) return;
      if (scene.awaits?.kind === 'owner-input' && payload.kind === 'owner-input') {
        // Echo the user reply as a real user_message item so it appears in the
        // active panel transcript scoped to the current state's visit.
        emit({
          kind: 'ItemStarted',
          id: `item-user-${payload.requestId}`,
          type: 'user_message',
          text: Object.values(payload.answers).join(' · '),
        });
        const nextIdx = scene.awaits.next(payload, cursor);
        advance(nextIdx);
        return;
      }
      if (scene.awaits?.kind === 'approval' && payload.kind === 'approval') {
        const nextIdx = scene.awaits.next(payload, cursor);
        advance(nextIdx);
        return;
      }
    },
    reset() {
      cancel();
      started = false;
      cursor = 0;
    },
  };
}
