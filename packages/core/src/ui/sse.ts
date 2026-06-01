import type {
  AppEvent,
  ReplayableAppEvent,
  RunMeta,
  Topology,
  UiMode,
  UiAppState,
  UiSnapshot,
} from './events.js';

export type UiEventLogOptions = {
  capacity?: number;
  run?: RunMeta;
  topology?: Topology;
  mode?: UiMode;
};

export type UiEventLog = {
  publish(event: AppEvent): ReplayableAppEvent;
  snapshot(): UiSnapshot;
  eventsAfter(lastEventId: string | null): ReplayableAppEvent[];
  subscribe(listener: () => void): () => void;
};

const DEFAULT_CAPACITY = 1_000;
const DIAGNOSTIC_LIMIT = 100;
const EMPTY_TOPOLOGY: Topology = {
  machineId: '',
  initial: '',
  nodes: [],
  edges: [],
};

function emptyPending(): UiAppState['pending'] {
  return {
    ownerInput: null,
    ownerChoice: null,
    fileApprovals: [],
    cmdApprovals: [],
    permissionApprovals: [],
    elicitations: [],
  };
}

function createInitialState(run: RunMeta | null, topology: Topology, mode?: UiMode): UiAppState {
  return {
    ...(mode !== undefined ? { mode } : {}),
    run,
    posture: {
      isTerminal: false,
      isAwaiting: false,
      submittedThisTurn: false,
      open: false,
    },
    activeTurn: null,
    currentState: null,
    topology,
    pending: emptyPending(),
    transcript: [],
    frameworkNotes: [],
    diagnostics: [],
    completedTurns: [],
  };
}

function normalizeCapacity(capacity: number | undefined): number {
  if (capacity === undefined || !Number.isSafeInteger(capacity) || capacity < 1) {
    return DEFAULT_CAPACITY;
  }
  return capacity;
}

function parseEventId(eventId: string): number | null {
  if (!/^[1-9]\d*$/.test(eventId)) {
    return null;
  }

  const parsed = Number(eventId);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function applyEventToState(state: UiAppState, event: AppEvent): void {
  switch (event.kind) {
    case 'AgentMessageDelta': {
      const existing = state.transcript.find((entry) => entry.id === event.id);
      if (existing) {
        existing.text += event.delta;
        existing.reasoning = existing.reasoning || event.reasoning === true;
      } else {
        state.transcript.push({
          id: event.id,
          text: event.delta,
          reasoning: event.reasoning === true,
        });
      }
      break;
    }
    case 'ItemStarted':
      break;
    case 'TurnStarted':
      state.activeTurn = { turnId: event.turnId };
      break;
    case 'StateChange':
      state.currentState = event.newState;
      break;
    case 'FrameworkNote':
      state.frameworkNotes.push(event);
      break;
    case 'TurnCompleted':
      state.completedTurns.push(event);
      if (state.activeTurn === null || state.activeTurn.turnId === event.turnId) {
        state.activeTurn = null;
      }
      break;
    case 'FreshClearBoundary':
      state.transcript = [];
      state.completedTurns = [];
      state.pending = emptyPending();
      state.posture = {
        ...state.posture,
        isAwaiting: false,
        submittedThisTurn: false,
      };
      state.activeTurn = null;
      break;
    case 'AbandonedThreadDiagnostic':
      state.diagnostics = [...state.diagnostics, event].slice(-DIAGNOSTIC_LIMIT);
      break;
    case 'PostureChange':
      state.posture = {
        ...state.posture,
        ...event.posture,
      };
      break;
    case 'ServerRequest':
      switch (event.method) {
        case 'item/tool/requestUserInput':
          state.pending.ownerInput = event;
          break;
        case 'item/fileChange/requestApproval':
          upsertById(state.pending.fileApprovals, event);
          break;
        case 'item/commandExecution/requestApproval':
          upsertById(state.pending.cmdApprovals, event);
          break;
        case 'item/permissions/requestApproval':
          upsertById(state.pending.permissionApprovals, event);
          break;
        case 'mcpServer/elicitation/request':
          upsertById(state.pending.elicitations, event);
          break;
      }
      break;
    case 'FileApprovalUpdated':
      state.pending.fileApprovals = state.pending.fileApprovals.map((approval) =>
        approval.id === event.id
          ? {
              ...approval,
              changes: event.changes,
            }
          : approval,
      );
      break;
    case 'ApprovalRequestResolved':
      state.pending.fileApprovals = removeById(state.pending.fileApprovals, event.id);
      state.pending.cmdApprovals = removeById(state.pending.cmdApprovals, event.id);
      state.pending.permissionApprovals = removeById(state.pending.permissionApprovals, event.id);
      state.pending.elicitations = removeById(state.pending.elicitations, event.id);
      break;
    case 'OwnerInputResolved':
      if (state.pending.ownerInput?.id === event.id) {
        state.pending.ownerInput = null;
      }
      break;
    case 'ResyncRequired':
      break;
  }
}

function upsertById<T extends { id: string }>(items: T[], item: T): void {
  const idx = items.findIndex((existing) => existing.id === item.id);
  if (idx === -1) {
    items.push(item);
    return;
  }
  items[idx] = item;
}

function removeById<T extends { id: string }>(items: T[], id: string): T[] {
  return items.filter((item) => item.id !== id);
}

export function createUiEventLog(options: UiEventLogOptions = {}): UiEventLog {
  const capacity = normalizeCapacity(options.capacity);
  const state = createInitialState(
    options.run ?? null,
    options.topology ?? EMPTY_TOPOLOGY,
    options.mode,
  );
  const retainedEvents: ReplayableAppEvent[] = [];
  const listeners = new Set<() => void>();
  let nextEventId = 1;

  function append(event: AppEvent, updateState: boolean): ReplayableAppEvent {
    const replayable = { id: String(nextEventId), event };
    nextEventId += 1;

    retainedEvents.push(replayable);
    if (retainedEvents.length > capacity) {
      retainedEvents.shift();
    }

    if (updateState) {
      applyEventToState(state, event);
    }

    return replayable;
  }

  function syntheticResync(
    reason: 'unknown-last-event-id' | 'event-buffer-overflow',
    requestedLastEventId: string,
  ): ReplayableAppEvent {
    return {
      id: nextEventId === 1 ? '0' : String(nextEventId - 1),
      event: {
        kind: 'ResyncRequired',
        reason,
        requestedLastEventId,
      },
    };
  }

  return {
    publish(event) {
      const replayable = append(event, true);
      for (const listener of [...listeners]) {
        listener();
      }
      return replayable;
    },
    snapshot() {
      return {
        latestEventId: nextEventId === 1 ? null : String(nextEventId - 1),
        state,
      };
    },
    eventsAfter(lastEventId) {
      if (lastEventId === null) {
        return [...retainedEvents];
      }

      const requestedId = parseEventId(lastEventId);
      if (requestedId === null || requestedId >= nextEventId) {
        return [syntheticResync('unknown-last-event-id', lastEventId)];
      }

      const firstRetained = retainedEvents[0];
      if (firstRetained === undefined) {
        return [syntheticResync('event-buffer-overflow', lastEventId)];
      }

      const firstRetainedId = parseEventId(firstRetained.id);
      if (firstRetainedId === null || requestedId < firstRetainedId) {
        return [syntheticResync('event-buffer-overflow', lastEventId)];
      }

      return retainedEvents.filter((event) => {
        const id = parseEventId(event.id);
        return id !== null && id > requestedId;
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function serializeSseEvent(event: ReplayableAppEvent): string {
  const dataLines = JSON.stringify(event.event, null, 2)
    .split('\n')
    .map((line) => `data: ${line}`);

  return [`id: ${event.id}`, `event: ${event.event.kind}`, ...dataLines, '', ''].join('\n');
}
