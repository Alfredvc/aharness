import { afterEach, describe, expect, it } from 'vitest';
import parent from './fixtures/embed/parent.fsm.js';
import a from './fixtures/embed/cyclic-a.fsm.js';
import b from './fixtures/embed/cyclic-b.fsm.js';
import nonExclusive from './fixtures/embed/non-exclusive-host.fsm.js';
import noFinalChildParent from './fixtures/embed/no-final-child.fsm.js';
import missingInputFsm from './fixtures/embed/missing-input.fsm.js';
import { verify, verify as verifyEmbed } from '../src/verify/index.js';
import { stateKeyPath } from '../src/state.js';
import { createFsm } from '../src/state/createFsm.js';
import type { SchemaSidecar } from '../src/types.js';

// Sidecar stubs for the parent's submit exits — provided so that
// `per-state-data-schema-resolvable` does not pollute `result.issues` with
// schema-resolution noise unrelated to the embedded-final check under test.
// The schemas are placeholder; the validator is permissive on purpose.
const sidecar = {
  router: {
    go: {
      jsonSchema: { type: 'object' as const },
      validate: () => ({ ok: true as const, data: {} }),
    },
  },
  'inner.go': {
    out: {
      jsonSchema: { type: 'object' as const },
      validate: () => ({ ok: true as const, data: {} }),
    },
    bad: {
      jsonSchema: { type: 'object' as const },
      validate: () => ({ ok: true as const, data: {} }),
    },
  },
};

interface CanonicalParentData {
  topic: string;
  shippedTopic: string | null;
}

interface CanonicalChildData {
  topic: string;
}

function buildCanonicalEmbedVerifierMachine() {
  const childFsm = createFsm<CanonicalChildData>();
  const child = childFsm.machine({
    id: 'canonicalVerifierChild',
    input: {
      topic: childFsm.input.string(),
    },
    data: ({ input }) => ({ topic: input.topic }),
    initial: 'compose',
    states: {
      compose: childFsm.state({
        prompt: (data) => `Compose a spec for ${data.topic}`,
        on: {
          ship: childFsm.submit<{}>({ to: 'shipped' }),
          reject: childFsm.submit<{}>({ to: 'failed' }),
        },
      }),
      shipped: childFsm.final({
        outcome: 'success',
        output: (data) => ({ topic: data.topic }),
      }),
      failed: childFsm.final({
        outcome: 'failure',
        output: () => ({ reason: 'rejected' as const }),
      }),
    },
  });

  const parentFsm = createFsm<CanonicalParentData>();
  return parentFsm.machine({
    id: 'canonicalVerifierParent',
    data: () => ({ topic: 'auth', shippedTopic: null }),
    initial: 'router',
    states: {
      router: parentFsm.state({
        prompt: 'Route into the embedded child',
        on: {
          go: parentFsm.submit<{}>({ to: 'spec' }),
        },
      }),
      spec: parentFsm.embed(child, {
        input: (data) => ({ topic: data.topic }),
        on: {
          shipped: {
            to: 'done',
            reduce: (draft, output) => {
              draft.shippedTopic = output.topic;
            },
          },
          failed: { to: 'router' },
        },
      }),
      done: parentFsm.final({ outcome: 'success' }),
    },
  });
}

const canonicalSidecar: SchemaSidecar = {
  router: {
    go: {
      jsonSchema: { type: 'object' },
      validate: (input: unknown) => ({ ok: true, data: input }),
    },
  },
  'spec.compose': {
    ship: {
      jsonSchema: { type: 'object' },
      validate: (input: unknown) => ({ ok: true, data: input }),
    },
    reject: {
      jsonSchema: {
        type: 'object',
      },
      validate: (input: unknown) => ({ ok: true, data: input }),
    },
  },
};

function canonicalEmbeddedMeta(machine: ReturnType<typeof buildCanonicalEmbedVerifierMachine>) {
  const specNode = machine.root.states['spec'];
  if (!specNode) throw new Error('canonical verifier fixture missing `spec` state');
  const embedded = (
    specNode.meta as {
      aharness: {
        embedded: {
          exits: string[];
          onMap: Record<string, unknown>;
          input?: unknown;
        };
      };
    }
  ).aharness.embedded;
  return { specNode, embedded };
}

function canonicalEmbeddedConfig(machine: ReturnType<typeof buildCanonicalEmbedVerifierMachine>) {
  const config = machine.config as {
    states?: Record<
      string,
      {
        meta?: {
          aharness?: {
            embedded?: {
              exits: string[];
              input?: unknown;
            };
          };
        };
      }
    >;
  };
  const embedded = config.states?.['spec']?.meta?.aharness?.embedded;
  if (!embedded) throw new Error('canonical verifier fixture missing config embedded meta');
  return embedded;
}

describe('verifier — embedded-final-must-be-wired', () => {
  // Negative-case mutation must hit the live `node.meta` that `iterStates` walks
  // (it walks `machine.root`, not `machine.config` — see state.ts:24-37).
  // We restore the original onMap after each test so the fixture stays clean
  // for sibling tests that share the import.
  let restorers: Array<() => void> = [];
  afterEach(() => {
    while (restorers.length > 0) restorers.pop()!();
  });

  it('passes for a parent FSM with a fully-wired embedded child', () => {
    const result = verify(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'embedded-final-must-be-wired');
    expect(issues).toEqual([]);
  });

  it('flags a constructed compound that omits a final from on-map', () => {
    // Mutate the live embedded.onMap on the StateNode that iterStates walks.
    // `parent.root.states.inner.meta.aharness.embedded.onMap` is the same
    // object the `embed()` combinator wrote at machine-construction time.
    const innerNode = parent.root.states['inner'];
    if (!innerNode) throw new Error('parent fixture missing `inner` state');
    const embedded = (
      innerNode.meta as {
        aharness: { embedded: { onMap: Record<string, unknown> } };
      }
    ).aharness.embedded;
    const savedFailed = embedded.onMap['failed'];
    delete embedded.onMap['failed'];
    restorers.push(() => {
      embedded.onMap['failed'] = savedFailed;
    });

    const result = verify(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'embedded-final-must-be-wired');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toMatch(/missing entries for final\(s\): failed/);
  });
});

describe('verifier — canonical createFsm().embed hosts', () => {
  it('accepts a well-formed canonical embed host and recurses into child submits', () => {
    const machine = buildCanonicalEmbedVerifierMachine();
    const result = verify(machine, canonicalSidecar);
    expect(result.errors).toEqual([]);

    const { embedded } = canonicalEmbeddedMeta(machine);
    expect(Object.keys(embedded.onMap).sort()).toEqual(['failed', 'shipped']);
  });

  it('flags missing and extra canonical embedded final handlers', () => {
    const machine = buildCanonicalEmbedVerifierMachine();
    const { embedded } = canonicalEmbeddedMeta(machine);
    delete embedded.onMap['failed'];
    embedded.onMap['unknownFinal'] = { target: 'router' };

    const result = verify(machine, canonicalSidecar);
    const issues = result.issues.filter((i) => i.check === 'embedded-final-must-be-wired');
    expect(issues.some((i) => /missing entries for final\(s\): failed/.test(i.message))).toBe(true);
    expect(issues.some((i) => /unknown final\(s\): unknownFinal/.test(i.message))).toBe(true);
  });

  it('flags canonical embed hosts that mix in state-only fields', () => {
    const machine = buildCanonicalEmbedVerifierMachine();
    const { specNode } = canonicalEmbeddedMeta(machine);
    (
      specNode.meta as {
        aharness: { entryPrompt?: string };
      }
    ).aharness.entryPrompt = 'not allowed on an embed host';

    const result = verify(machine, canonicalSidecar);
    const issues = result.issues.filter((i) => i.check === 'embedded-state-exclusive');
    expect(issues.some((i) => i.stateId === 'spec' && /entryPrompt/.test(i.message))).toBe(true);
  });

  it('flags canonical embed hosts whose required child input is not projected', () => {
    const machine = buildCanonicalEmbedVerifierMachine();
    const embedded = canonicalEmbeddedConfig(machine);
    delete embedded.input;

    const result = verify(machine, canonicalSidecar);
    const issues = result.issues.filter((i) => i.check === 'embedded-input-must-be-satisfied');
    expect(issues.some((i) => i.stateId === 'spec' && /topic/.test(i.message))).toBe(true);
  });

  it('flags canonical embedded children with no finals or invalid final ids', () => {
    const noFinals = buildCanonicalEmbedVerifierMachine();
    canonicalEmbeddedMeta(noFinals).embedded.exits.length = 0;
    const noFinalIssues = verify(noFinals, canonicalSidecar).issues.filter(
      (i) => i.check === 'embedded-child-must-have-finals',
    );
    expect(noFinalIssues.some((i) => i.stateId === 'spec')).toBe(true);

    const badFinalId = buildCanonicalEmbedVerifierMachine();
    canonicalEmbeddedMeta(badFinalId).embedded.exits.push('xstate.bad');
    const finalIdIssues = verify(badFinalId, canonicalSidecar).issues.filter(
      (i) => i.check === 'embedded-final-id-name-shape',
    );
    expect(finalIdIssues.some((i) => /xstate\.bad/.test(i.message))).toBe(true);
  });
});

describe('verifier — embedding-acyclic', () => {
  it('passes when there is no cycle', () => {
    const result = verify(a, {});
    const issues = result.issues.filter((i) => i.check === 'embedding-acyclic');
    expect(issues).toEqual([]);
  });

  it('flags a hand-constructed A→B→A cycle', () => {
    // Hand-construct a cycle by mutating embedded.childConfig pointers.
    // JSON.parse(JSON.stringify(...)) strips functions; that is acceptable here
    // because `checkEmbeddingAcyclic` reads only `meta.aharness.embedded.{source,
    // childConfig}` plus `states` keys — none of which are functions. The
    // cyclic fixtures use string-only `entryPrompt` and final() with no
    // `output` callback, so no information is lost. If a future maintainer
    // adds a function to the cyclic fixtures, switch to cloneConfigPreservingFns.
    const aCfg = JSON.parse(JSON.stringify(a.config)) as Record<string, unknown>;
    const bCfg = JSON.parse(JSON.stringify(b.config)) as Record<string, unknown>;
    // Make A's `done` state pretend to be embedded(B), and B's `done` embed(A).
    type N = { meta?: { aharness?: { embedded?: unknown } } };
    const aDone = (aCfg.states as Record<string, N>).done!;
    const bDone = (bCfg.states as Record<string, N>).done!;
    aDone.meta = {
      aharness: {
        embedded: { source: 'cyclicB', exits: ['done'], onMap: {}, childConfig: bCfg },
      },
    };
    bDone.meta = {
      aharness: {
        embedded: { source: 'cyclicA', exits: ['done'], onMap: {}, childConfig: aCfg },
      },
    };
    const fakeMachine = { ...a, config: aCfg } as typeof a;
    const result = verify(fakeMachine, {});
    const issues = result.issues.filter((i) => i.check === 'embedding-acyclic');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toMatch(/cycle/);
  });
});

describe('verifier audit — existing checks recurse into embedded states', () => {
  // Mutation must hit live `node.meta` since `iterStates` walks `machine.root`,
  // not `machine.config`. We restore after each test.
  let restorers: Array<() => void> = [];
  afterEach(() => {
    while (restorers.length > 0) restorers.pop()!();
  });

  it('flags missing entryPrompt inside an embedded child via qualified id', () => {
    // Mutate the live `node.meta.aharness.entryPrompt` on the inner.go
    // StateNode so iterStates(machine) sees it.
    const innerNode = parent.root.states['inner'];
    if (!innerNode) throw new Error('parent fixture missing `inner` state');
    const goNode = innerNode.states['go'];
    if (!goNode) throw new Error('parent fixture missing `inner.go` state');
    const aharnessMeta = (goNode.meta as { aharness: { entryPrompt: string | (() => string) } })
      .aharness;
    const saved = aharnessMeta.entryPrompt;
    aharnessMeta.entryPrompt = '';
    restorers.push(() => {
      aharnessMeta.entryPrompt = saved;
    });

    const result = verifyEmbed(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'entryPrompt-paired');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.stateId).toMatch(/inner\.go/);
  });

  it('per-state-data-schema-resolvable looks up qualified ids', () => {
    // Sidecar keyed by `inner.go` (qualified) — verify lookup works.
    const goodSidecar = {
      'inner.go': {
        out: {
          jsonSchema: {
            type: 'object' as const,
            properties: { ok: { type: 'boolean' as const } },
            required: ['ok'],
          },
          validate: () => ({ ok: true as const, data: {} }),
        },
        bad: {
          jsonSchema: {
            type: 'object' as const,
            properties: { ok: { type: 'boolean' as const } },
            required: ['ok'],
          },
          validate: () => ({ ok: true as const, data: {} }),
        },
      },
      router: {
        go: {
          jsonSchema: {
            type: 'object' as const,
            properties: { choice: { type: 'string' as const } },
            required: ['choice'],
          },
          validate: () => ({ ok: true as const, data: {} }),
        },
      },
    };
    const result = verifyEmbed(parent, goodSidecar as never);
    const issues = result.issues.filter((i) => i.check === 'per-state-data-schema-resolvable');
    expect(issues).toEqual([]);
  });
});

describe('verifier audit — qualified state IDs through compound states', () => {
  it('stateKeyPath returns the dotted qualified id for an embedded child', () => {
    const innerNode = parent.root.states['inner'];
    const goNode = innerNode!.states['go'];
    expect(stateKeyPath(goNode!)).toBe('inner.go');
    expect(stateKeyPath(innerNode!)).toBe('inner');
  });
});

describe('verifier — final() interop with classification + reachability', () => {
  it('does not emit final-classification issues for the parent fixture (final() everywhere)', () => {
    const result = verify(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'final-classification');
    expect(issues).toEqual([]);
  });

  it('does not emit terminal-reachability issues — every state has a path to a terminal', () => {
    const result = verify(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'terminal-reachability');
    expect(issues).toEqual([]);
  });

  it('does not emit reachability issues — every state is reachable', () => {
    const result = verify(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'reachability');
    expect(issues).toEqual([]);
  });

  it("synthesized host on['<finalId>'] keys are surfaced in StateNode.transitions (concern #6 fence)", () => {
    // Assert directly that the host compound's resolved transitions Map has
    // entries for the synth bare-finalId events. If this ever fails, the
    // outgoingTargets walker would silently miss them and terminal-reachability
    // would emit false positives.
    const innerNode = parent.root.states['inner'];
    if (!innerNode) throw new Error('parent fixture missing inner');
    const transitionEvents = new Set<string>();
    for (const [eventType] of innerNode.transitions ?? new Map()) {
      transitionEvents.add(eventType as string);
    }
    expect(transitionEvents.has('shipped')).toBe(true);
    expect(transitionEvents.has('failed')).toBe(true);
  });
});

describe('verifier — final-output-must-be-function', () => {
  let restorers: Array<() => void> = [];
  afterEach(() => {
    while (restorers.length > 0) restorers.pop()!();
  });

  it("passes when final()'s output is a function (parent fixture's child has output: ({event}) => ({...}))", () => {
    const result = verify(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'final-output-must-be-function');
    expect(issues).toEqual([]);
  });

  it('passes when final() declares no output at all', () => {
    const doneNode = parent.root.states['done'];
    expect((doneNode!.meta as { aharness: { output?: unknown } }).aharness.output).toBeUndefined();
    const result = verify(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'final-output-must-be-function');
    expect(issues).toEqual([]);
  });

  it('flags a hand-built terminal meta whose output is not a function', () => {
    const innerNode = parent.root.states['inner'];
    const shippedNode = innerNode!.states['shipped'];
    if (!shippedNode) throw new Error('parent fixture missing inner.shipped');
    const aharnessMeta = (shippedNode.meta as { aharness: { output?: unknown } }).aharness;
    const saved = aharnessMeta.output;
    aharnessMeta.output = 'not a function';
    restorers.push(() => {
      aharnessMeta.output = saved;
    });

    const result = verify(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'final-output-must-be-function');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.stateId).toMatch(/^inner\.shipped$/);
    expect(issues[0]!.message).toMatch(/output must be a function/);
    expect(issues[0]!.message).toMatch(/got string/);
  });
});

describe('verifier — embedded-state-exclusive', () => {
  it('passes for the well-formed parent fixture (host carries only the embed)', () => {
    const result = verify(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'embedded-state-exclusive');
    expect(issues).toEqual([]);
  });

  it('flags an embed-host that bolts on entryPrompt via spread', () => {
    const result = verify(nonExclusive, {} as never);
    const issues = result.issues.filter((i) => i.check === 'embedded-state-exclusive');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.stateId).toBe('inner');
    expect(issues[0]!.message).toMatch(/entryPrompt|forbidden field|host state may not declare/);
  });

  it('flags an embed-host that bolts on author-written on: keys', () => {
    // Mutate the live meta: pretend the host carries an author on['foo'].
    const innerNode = parent.root.states['inner'];
    if (!innerNode) throw new Error('parent fixture missing inner');
    // The synthesizer wrote on['shipped'] and on['failed'] from embed.onMap.
    // Add an author-only key ('foo') that is NOT in the embedded.onMap.
    type N = { on?: Record<string, unknown> };
    const innerOn = (innerNode as N).on ?? ((innerNode as N).on = {});
    innerOn['foo'] = [{ target: 'router' }];
    try {
      const result = verify(parent, sidecar as never);
      const issues = result.issues.filter((i) => i.check === 'embedded-state-exclusive');
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]!.message).toMatch(/foo|unexpected on-key|not in embed.on/);
    } finally {
      delete innerOn['foo'];
    }
  });

  it('flags an embed-host that bolts on `always` via spread', () => {
    type N = { always?: unknown };
    const innerNode = parent.root.states['inner'];
    if (!innerNode) throw new Error('parent fixture missing inner');
    (innerNode as N).always = [{ target: 'router' }];
    try {
      const result = verify(parent, sidecar as never);
      const issues = result.issues.filter((i) => i.check === 'embedded-state-exclusive');
      expect(issues.some((i) => /always/.test(i.message))).toBe(true);
    } finally {
      delete (innerNode as N).always;
    }
  });
});

describe('verifier — embedded-child-must-have-finals', () => {
  it('passes for the well-formed parent fixture (child has shipped + failed finals)', () => {
    const result = verify(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'embedded-child-must-have-finals');
    expect(issues).toEqual([]);
  });

  it('flags a hand-built embedded shape with no finals', () => {
    const result = verify(noFinalChildParent, {} as never);
    const issues = result.issues.filter((i) => i.check === 'embedded-child-must-have-finals');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.stateId).toBe('inner');
    expect(issues[0]!.message).toMatch(/no final\(\) nodes|must declare at least one final/);
  });
});

describe('verifier — embedded-final-id-name-shape', () => {
  let restorers: Array<() => void> = [];
  afterEach(() => {
    while (restorers.length > 0) restorers.pop()!();
  });

  it('passes for plain identifier final ids (parent fixture: shipped, failed)', () => {
    const result = verify(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'embedded-final-id-name-shape');
    expect(issues).toEqual([]);
  });

  it("flags a final id starting with 'xstate.'", () => {
    const innerNode = parent.root.states['inner'];
    const embedded = (innerNode!.meta as { aharness: { embedded: { exits: string[] } } }).aharness
      .embedded;
    const saved = [...embedded.exits];
    embedded.exits.push('xstate.bogus');
    restorers.push(() => {
      embedded.exits.length = 0;
      embedded.exits.push(...saved);
    });

    const result = verify(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'embedded-final-id-name-shape');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toMatch(/xstate\./);
  });

  it("flags a final id containing '.' (qualified-id separator) without 'xstate.' prefix", () => {
    const innerNode = parent.root.states['inner'];
    const embedded = (innerNode!.meta as { aharness: { embedded: { exits: string[] } } }).aharness
      .embedded;
    const saved = [...embedded.exits];
    embedded.exits.push('outer.shipped');
    restorers.push(() => {
      embedded.exits.length = 0;
      embedded.exits.push(...saved);
    });

    const result = verify(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'embedded-final-id-name-shape');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toMatch(/qualified-state-id separator|state-key|registry/i);
    // Must not be misclassified as the 'xstate.' rule.
    expect(issues[0]!.message).not.toMatch(/reserved XState event namespace/);
  });
});

describe('verifier — embedded-input-must-be-satisfied', () => {
  // Restorers undo any per-test mutation of `machine.config` so other tests
  // sharing the same imported fixture see a clean tree.
  let restorers: Array<() => void> = [];
  afterEach(() => {
    while (restorers.length > 0) restorers.pop()!();
  });

  it('flags an embed() that omits the projection when child requires fields', () => {
    const result = verify(missingInputFsm, {} as never);
    const issues = result.issues.filter((i) => i.check === 'embedded-input-must-be-satisfied');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toMatch(/topic/);
    expect(issues[0]!.message).toMatch(/childWithInput/);
    expect(issues[0]!.severity).toBe('error');
  });

  it('passes when the child declares no input (parent fixture: child has no input)', () => {
    // The `parent` fixture's child has no `input` declaration, so there are
    // no required fields and the check has nothing to flag — including for
    // an embed() that itself omits the projection.
    const result = verify(parent, sidecar as never);
    const issues = result.issues.filter((i) => i.check === 'embedded-input-must-be-satisfied');
    expect(issues).toEqual([]);
  });

  it('still recurses into nested states when a projection throws', () => {
    // Construct a parent whose top-level `embed()` has a throwing projection
    // AND a sibling state that contains a deeper embed with a missing input.
    // The walker must emit the warning for the throwing projection AND the
    // error for the deeper missing input — not stop after the throw.
    type EmbeddedNode = {
      meta?: {
        aharness?: {
          embedded?: {
            input?: (a: { context: Record<string, unknown> }) => Record<string, unknown>;
            childConfig?: { input?: Record<string, unknown> };
          };
        };
      };
    };
    type LooseConfig = { states?: Record<string, EmbeddedNode> };

    // Inject a throwing projection on the top-level `inner` embed.
    const cfg = missingInputFsm.config as unknown as LooseConfig;
    const innerNode = cfg.states?.['inner'];
    if (!innerNode) throw new Error('missing-input fixture: no `inner` state');
    const innerEmbedded = innerNode.meta?.aharness?.embedded;
    if (!innerEmbedded) throw new Error('missing-input fixture: `inner` is not an embed-host');
    const savedInnerInput = innerEmbedded.input;
    innerEmbedded.input = () => {
      throw new Error('throws on synthesized empty context');
    };
    restorers.push(() => {
      innerEmbedded.input = savedInnerInput;
    });

    // Inject a deeper synthetic embed-host as a child of `inner` so the
    // walker visits it AFTER the throwing projection on `inner`. The walker
    // recurses into `node.states` unconditionally, so any node hung off
    // `inner.states` will be visited; here we add `deeper` whose meta mimics
    // another missing-input embed-host. Qualified pathLabel becomes
    // `inner.deeper`. The deeper node has no `input` projection → the check's
    // missing-fields branch fires for required field `topic`.
    const childInputDecl: Record<string, { meta: Record<string, unknown> }> = {
      // No `default` → field is required.
      topic: { meta: {} },
    };
    const innerLoose = innerNode as EmbeddedNode & { states?: Record<string, EmbeddedNode> };
    const savedDeeper = innerLoose.states?.['deeper'];
    if (!innerLoose.states) innerLoose.states = {};
    innerLoose.states['deeper'] = {
      meta: {
        aharness: {
          embedded: {
            childConfig: { input: childInputDecl },
            // No `input` projection → providedKeys empty → required field
            // `topic` will be reported as missing.
          } as never,
        },
      },
    };
    restorers.push(() => {
      if (savedDeeper === undefined) {
        delete innerLoose.states!['deeper'];
      } else {
        innerLoose.states!['deeper'] = savedDeeper;
      }
    });

    const result = verify(missingInputFsm, {} as never);
    const issues = result.issues.filter((i) => i.check === 'embedded-input-must-be-satisfied');

    // The throwing projection on `inner` must produce a warning, not stop
    // the walk.
    const warnings = issues.filter((i) => i.severity === 'warning');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.stateId === 'inner')).toBe(true);
    expect(warnings.some((w) => /could not statically probe/.test(w.message))).toBe(true);

    // And the deeper missing-input embed must still be flagged as an error.
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.stateId === 'inner.deeper')).toBe(true);
    expect(errors.some((e) => /topic/.test(e.message))).toBe(true);
  });
});
