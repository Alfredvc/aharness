import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { createFsm } from '../src/state/createFsm.js';
import parent from './fixtures/embed/parent.fsm.js';
import parentWithAwait from './fixtures/embed/parent-with-await.fsm.js';

function buildCanonicalParent() {
  const childFsm = createFsm<{ summary: string | null }>();
  const child = childFsm.machine({
    id: 'canonical-rtc-child',
    data: () => ({ summary: null }),
    initial: 'compose',
    states: {
      compose: childFsm.state({
        prompt: 'compose',
        on: {
          finish: childFsm.submit<{ summary: string }>({
            to: 'shipped',
            reduce: (draft, payload) => {
              draft.summary = payload.summary;
            },
          }),
        },
      }),
      shipped: childFsm.final({
        outcome: 'success',
        output: (data) => ({ summary: data.summary ?? '' }),
      }),
    },
  });

  const parentFsm = createFsm<{ summary: string | null }>();
  return parentFsm.machine({
    id: 'canonical-rtc-parent',
    data: () => ({ summary: null }),
    initial: 'router',
    states: {
      router: parentFsm.state({
        prompt: 'router',
        on: {
          go: parentFsm.submit<{}>({ to: 'inner' }),
        },
      }),
      inner: parentFsm.embed(child, {
        input: () => ({}),
        on: {
          shipped: {
            to: 'done',
            reduce: (draft, output) => {
              draft.summary = output.summary;
            },
          },
        },
      }),
      done: parentFsm.final({ outcome: 'success' }),
    },
  });
}

describe('embed() — run-to-completion subscriber semantics', () => {
  it('subscribe fires exactly once for the SUBMIT that drives entry-raise → host on-map → done', () => {
    // SUBMIT__inner.go__out enters inner.shipped (entry-raise), processes the
    // raised 'shipped' event, fires the host's on['shipped'] to done, enters
    // the parent's `done` final. Per XState's run-to-completion, subscribers
    // see ONE snapshot for the whole macrostep — the post-drain {value: 'done'}.
    const actor = createActor(parent);
    const snapshots: Array<{ value: unknown; status: string }> = [];
    actor.start();
    actor.subscribe((s) => snapshots.push({ value: s.value, status: s.status }));
    actor.send({ type: 'SUBMIT__router__go', payload: { choice: 'embed' } });
    // After the router transition, subscribers see {value: {inner: 'go'}}.
    expect(snapshots).toEqual([{ value: { inner: 'go' }, status: 'active' }]);
    // Now the SUBMIT that drives the multi-step macrostep.
    actor.send({ type: 'SUBMIT__inner.go__out', payload: { ok: true } });
    // The intermediate {inner: 'shipped'} snapshot must NOT appear.
    // Only the post-drain {value: 'done', status: 'done'} should land in the array.
    expect(snapshots).toEqual([
      { value: { inner: 'go' }, status: 'active' },
      { value: 'done', status: 'done' },
    ]);
  });

  it('getPersistedSnapshot() taken between sends never observes the intermediate {inner: shipped} state', () => {
    // The daemon's snapshot persist runs from a subscribe callback (CLAUDE.md
    // hard rule 7). This test asserts no synchronous read between sends can
    // catch the actor mid-macrostep at {inner: shipped}.
    const actor = createActor(parent);
    actor.start();
    actor.send({ type: 'SUBMIT__router__go', payload: { choice: 'embed' } });
    expect(actor.getPersistedSnapshot().value).toEqual({ inner: 'go' });
    actor.send({ type: 'SUBMIT__inner.go__out', payload: { ok: true } });
    // Synchronous read — value is post-drain.
    expect(actor.getPersistedSnapshot().value).toBe('done');
    expect(actor.getPersistedSnapshot().status).toBe('done');
  });

  it('snapshot/resume round-trips a paused {inner: go} state', () => {
    const a = createActor(parent);
    a.start();
    a.send({ type: 'SUBMIT__router__go', payload: { choice: 'embed' } });
    expect(a.getSnapshot().value).toEqual({ inner: 'go' });
    const persisted = a.getPersistedSnapshot();
    a.stop();

    const b = createActor(parent, { snapshot: persisted });
    b.start();
    expect(b.getSnapshot().value).toEqual({ inner: 'go' });
    // Resume continues through the embed boundary with the same machine ref —
    // the per-machine output registry is bound on the setup closure.
    b.send({ type: 'SUBMIT__inner.go__out', payload: { ok: true } });
    expect(b.getSnapshot().status).toBe('done');
    expect(b.getSnapshot().value).toBe('done');
    expect(
      (b.getSnapshot().context as { capturedShippedOutput: unknown }).capturedShippedOutput,
    ).toEqual({ ok: true, receivedFromSubmit: true });
  });

  it('snapshot/resume round-trips a completed run', () => {
    const a = createActor(parent);
    a.start();
    a.send({ type: 'SUBMIT__router__go', payload: { choice: 'embed' } });
    a.send({ type: 'SUBMIT__inner.go__out', payload: { ok: true } });
    expect(a.getSnapshot().status).toBe('done');
    const persisted = a.getPersistedSnapshot();
    a.stop();

    const b = createActor(parent, { snapshot: persisted });
    b.start();
    expect(b.getSnapshot().status).toBe('done');
    expect(b.getSnapshot().value).toBe('done');
  });

  it('AWAIT-driven entry into embedded final also run-to-completes through the boundary', () => {
    // Parallel coverage to test #1 on the AWAIT path. The child fixture
    // `child-with-await-final.fsm.ts` declares `ask ──await(wait)→ shipped`;
    // the parent embeds it as `inner` with `on: { shipped: { target: 'done' } }`.
    // Driving `AWAIT__inner.ask__wait` enters inner.shipped (entry-raise),
    // processes the raised 'shipped' event, fires the host's on['shipped'] to
    // done, enters the parent's `done` final. Subscribers must see ONE
    // post-drain snapshot {value: 'done', status: 'done'} — the intermediate
    // {inner: 'shipped'} state is invisible per XState run-to-completion.
    const actor = createActor(parentWithAwait);
    const snapshots: Array<{ value: unknown; status: string }> = [];
    actor.start();
    actor.subscribe((s) => snapshots.push({ value: s.value, status: s.status }));
    actor.send({ type: 'SUBMIT__router__go', payload: { choice: 'embed' } });
    expect(snapshots).toEqual([{ value: { inner: 'ask' }, status: 'active' }]);
    actor.send({ type: 'AWAIT__inner.ask__wait' });
    // The intermediate {inner: 'shipped'} snapshot must NOT appear.
    expect(snapshots).toEqual([
      { value: { inner: 'ask' }, status: 'active' },
      { value: 'done', status: 'done' },
    ]);
  });

  it('canonical embed rejects raw XState sends into child finals without aharness preflight metadata', async () => {
    const actor = createActor(buildCanonicalParent());
    const error = new Promise<unknown>((resolve) => {
      actor.subscribe({
        next: () => {},
        error: resolve,
      });
    });
    actor.start();

    actor.send({ type: 'SUBMIT__router__go', payload: {} });
    actor.send({ type: 'SUBMIT__inner.compose__finish', payload: { summary: 'draft' } });

    await expect(error).resolves.toMatchObject({
      message: expect.stringContaining('without aharness preflight metadata'),
    });
  });
});
