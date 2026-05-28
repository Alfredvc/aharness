export interface ActiveThreadBinding {
  /** Optional read used by readiness checks before startup thread/start completes. */
  current(): string | undefined;
  /** Required read for internal runtime paths that must only run after thread/start. */
  require(): string;
  /** True when the id was a previous active parent thread replaced by a later parent. */
  isAbandoned(threadId: string): boolean;
  /** Mark a parent thread id as no longer allowed to mutate live runtime state. */
  markAbandoned(threadId: string): void;
  /** Subscribe to future successful set() notifications. */
  subscribe(listener: (threadId: string) => void): () => void;
  /** Atomically replace the active parent thread id for future routing decisions. */
  set(threadId: string): void;
}

export interface ActiveThreadBindingOptions {
  readonly onChange?: (threadId: string) => void;
}

export function createActiveThreadBinding(
  initialThreadId?: string,
  options: ActiveThreadBindingOptions = {},
): ActiveThreadBinding {
  let currentThreadId: string | undefined;
  const abandonedParentThreadIds = new Set<string>();
  const subscribers: Array<(threadId: string) => void> = [];

  function validate(threadId: string): string {
    if (threadId.length === 0) {
      throw new Error('active thread id must be non-empty');
    }
    return threadId;
  }

  if (initialThreadId !== undefined) {
    currentThreadId = validate(initialThreadId);
  }

  function subscribe(listener: (threadId: string) => void): () => void {
    subscribers.push(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const idx = subscribers.indexOf(listener);
      if (idx !== -1) {
        subscribers.splice(idx, 1);
      }
    };
  }

  if (options.onChange !== undefined) {
    subscribe(options.onChange);
  }

  function notify(threadId: string): void {
    for (const listener of [...subscribers]) {
      try {
        listener(threadId);
      } catch {
        // Subscriber failures must not prevent the binding from updating
        // or later subscribers from observing the new active thread.
      }
    }
  }

  return {
    current() {
      return currentThreadId;
    },
    require() {
      if (currentThreadId === undefined) {
        throw new Error('active thread binding read before thread/start completed');
      }
      return currentThreadId;
    },
    isAbandoned(threadId) {
      return abandonedParentThreadIds.has(threadId);
    },
    markAbandoned(threadId) {
      abandonedParentThreadIds.add(validate(threadId));
    },
    subscribe,
    set(threadId) {
      const nextThreadId = validate(threadId);
      const previousThreadId = currentThreadId;
      if (previousThreadId !== undefined && previousThreadId !== nextThreadId) {
        abandonedParentThreadIds.add(previousThreadId);
      }
      abandonedParentThreadIds.delete(nextThreadId);
      currentThreadId = nextThreadId;
      notify(currentThreadId);
    },
  };
}
