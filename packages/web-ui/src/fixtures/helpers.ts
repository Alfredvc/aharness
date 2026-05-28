// Shared frame builders used by both fixture scripts.

import type { AppEvent } from '../types/events.js';
import type { Frame } from './script.js';

export function stream(itemId: string, text: string, chunk = 14): Frame[] {
  const out: Frame[] = [];
  for (let i = 0; i < text.length; i += chunk) {
    const slice = text.slice(i, i + chunk);
    out.push({
      at: i === 0 ? 60 : 26,
      event: { kind: 'AgentMessageDelta', id: itemId, delta: slice },
    });
  }
  return out;
}

export function enter(
  to: string,
  cause: 'submit' | 'await' | 'always' | 'embed-final' | 'boot',
  from: string | null,
  awaits = false,
  visitCount = 1,
  outcome?: 'success' | 'failure',
): Frame {
  const leaf = to.split('.').pop()!;
  return {
    at: 0,
    event: {
      kind: 'StateChange',
      from,
      to,
      cause,
      newState: {
        path: to,
        leaf,
        kind: outcome ? 'terminal' : 'stateful',
        ...(awaits ? { awaitsOwnerText: { messageToUser: '' } } : {}),
        exits: [],
        visitCount,
      },
    },
  };
}

export function modelMsg(id: string, text: string): Frame[] {
  return [
    { at: 0, event: { kind: 'ItemStarted', id, type: 'agent_message', text: '' } },
    ...stream(id, text),
  ];
}

export function submitFrame(id: string, args: object): Frame {
  return {
    at: 200,
    event: {
      kind: 'ItemStarted',
      id,
      type: 'function_call',
      name: 'harness_submit',
      arguments: JSON.stringify(args, null, 2),
    },
  };
}

export function turnDone(id: string, finishReason: 'tool_calls' | 'stop' = 'tool_calls'): Frame {
  return {
    at: 0,
    event: { kind: 'TurnCompleted', turnId: id, finishReason },
  };
}

const STATE_ENTRY = (to: string) =>
  `You have entered \`${to.split('.').pop()}\`. Read the active state's exits and submit when ready.`;

export function syntheticOrientation(id: string, to: string): Frame {
  return {
    at: 240,
    event: {
      kind: 'ItemStarted',
      id,
      type: 'user_message',
      text: STATE_ENTRY(to),
    },
  };
}

export function toolCall(id: string, name: string, args: object, gap = 200): Frame {
  return {
    at: gap,
    event: {
      kind: 'ItemStarted',
      id,
      type: 'function_call',
      name,
      arguments: JSON.stringify(args, null, 2),
    },
  };
}

export function toolResult(
  id: string,
  name: string,
  output: string,
  ok: boolean,
  gap = 220,
): Frame {
  return {
    at: gap,
    event: {
      kind: 'ItemStarted',
      id,
      type: 'function_call_output',
      name,
      output,
      ok,
    },
  };
}

export type { AppEvent };
