/**
 * Example user FSM — 9-step requirement-gathering process (Codex variant).
 *
 * Migrated to the exits-codegen shape:
 *   - `state<Ctx>({ entryPrompt, exits })` returns a full XState state
 *     config directly (no `meta: { harness: state(...) }` wrapper). The `on:`
 *     block is synthesised from `exits` by `harness.machine`; authors never
 *     write `SUBMIT__<stateId>__<exitName>` event keys.
 *   - Single-branch submit exits: `exit<T>({ to, actions })`.
 *   - Multi-branch submit exits: `exit<T>({ when: [...] })` where the
 *     last entry is always an unguarded catch-all.
 *   - `passive()` and `terminal()` return spreadable XState state configs;
 *     attach `entry`, `always`, etc. via spread: `{ ...passive(), entry: … }`.
 *   - Owner-yield is declared via `awaitsOwnerText: { messageToUser }` on
 *     states that need a free-text owner reply. The framework auto-injects
 *     a per-entry preamble instructing the model to call codex's built-in
 *     `request_user_input` before submitting; the reply is returned to the
 *     model directly as the tool-call result. No `await` exit is needed —
 *     the state advances on the typed submit, not on the owner reply itself.
 *   - `setup({...}).createMachine(...)` -> `harness.machine(...)` so the
 *     wrapper can inject framework-managed visit-count and owner-reply
 *     context fields. Guards and actions are declared inline on
 *     transitions / state entries because `harness.machine` runs its
 *     own `setup()` to register the framework actions.
 */
import { assign } from 'xstate';
import {
  harness,
  passive,
  state,
  terminal,
  exit,
  writeArtifact,
  type HarnessInput,
  type RunDir,
} from '@aharness/core';

// ─── Domain types ───────────────────────────────────────────────────────────

interface RequirementEntry {
  id: string;
  text: string;
  fitCriterion: string;
}

interface ConflictEntry {
  ids: string[];
  reason: string;
}

interface ResearchResult {
  requirementId: string;
  notes: string;
  references: string[];
}

type EditOp =
  | { op: 'add'; requirement: RequirementEntry }
  | { op: 'remove'; id: string }
  | { op: 'replace'; id: string; requirement: RequirementEntry };

// ─── Submit payloads ────────────────────────────────────────────────────────

interface AskGoalPayload {
  goal: string;
}

// Discriminated unions are wrapped in an object property because
// Anthropic's tool API rejects `anyOf`/`oneOf`/`allOf` at the top level
// of a tool input schema. The `@aharness/core` loader enforces this at
// verify time (issue code `exit-payload-non-object`).
interface IteratePayload {
  next: { done: false; requirement: RequirementEntry } | { done: true };
}

interface ResearchPayload {
  findings: ResearchResult[];
}

interface FlagPayload {
  conflicts: ConflictEntry[];
}

interface ProbePayload {
  additions: RequirementEntry[];
}

interface RevisePayload {
  next: { done: false; edit: EditOp } | { done: true };
}

interface ReviewPayload {
  verdict: 'pass' | 'rework';
  notes: string;
}

// ─── Context ────────────────────────────────────────────────────────────────

interface Ctx {
  harness: { runDir: RunDir; runId: string };
  goal: string | null;
  records: RequirementEntry[];
  findings: ResearchResult[];
  conflicts: ConflictEntry[];
  reviewerVerdict: 'pass' | 'rework' | null;
}

// ─── Render helpers ─────────────────────────────────────────────────────────

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function renderRequirementsMd(records: RequirementEntry[]): string {
  if (records.length === 0) return '# Requirements\n\n(none)\n';
  const lines = ['# Requirements', '', '| ID | Text | Fit criterion |', '|---|---|---|'];
  for (const r of records)
    lines.push(`| ${r.id} | ${escapeMd(r.text)} | ${escapeMd(r.fitCriterion)} |`);
  return lines.join('\n') + '\n';
}

function renderRequirementsCsv(records: RequirementEntry[]): string {
  const rows: string[][] = [['id', 'text', 'fitCriterion']];
  for (const r of records) rows.push([r.id, r.text, r.fitCriterion]);
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function fireRender(ctx: Ctx): void {
  // Fire-and-forget: writeArtifact is async but xstate `entry` is sync.
  // Errors surface through the run's event log + stderr; the FSM does not
  // gate on artifact durability for v1 (per SPEC §5.6 wording).
  void writeArtifact(
    ctx.harness.runDir,
    'requirements.md',
    renderRequirementsMd(ctx.records),
  ).catch((err: unknown) => {
    console.error('[requirement-spec] writeArtifact requirements.md failed:', err);
  });
  void writeArtifact(
    ctx.harness.runDir,
    'requirements.csv',
    renderRequirementsCsv(ctx.records),
  ).catch((err: unknown) => {
    console.error('[requirement-spec] writeArtifact requirements.csv failed:', err);
  });
}

// ─── Inline guards / actions (typed via state<Ctx> + exit<P>) ──────────────
//
// `harness.machine` runs its own `setup()` to register framework actions,
// so user-defined actions/guards declared via setup() would be discarded.
// Inline functions on transitions get their types via contextual typing:
// `TContext` from `state<Ctx>(...)` and `event.payload: P` from each
// wrapping `exit<P>({...})` factory call. The one entry-action helper
// (`renderArtifacts`) is typed explicitly because passive/terminal states
// are matched against xstate's bare entry slot — `TContext` flows from the
// typed `context()` factory return below.

const renderArtifacts = ({ context }: { context: Ctx }) => {
  fireRender(context);
};

// ─── Machine ────────────────────────────────────────────────────────────────

export const machine = harness.machine({
  id: 'requirement-spec',
  initial: 'askGoal',
  // `TContext` is inferred from this factory's return type; the FSM
  // declares no user `input:` fields, so the typed `input` parameter is
  // an empty object — the framework-supplied `runDir`/`runId` ride
  // outside the typed surface and are read through a one-time cast.
  context: ({ input }): Ctx => {
    const hi = input as unknown as HarnessInput;
    return {
      harness: { runDir: hi.runDir, runId: hi.runId },
      goal: null,
      records: [],
      findings: [],
      conflicts: [],
      reviewerVerdict: null,
    };
  },
  states: {
    askGoal: state<Ctx>({
      entryPrompt:
        "Capture the owner's goal for this requirement-gathering session, quoting what they said.",
      awaitsOwnerText: {
        messageToUser:
          'What is the goal of this requirement-gathering session? Describe the product or feature you want a requirements spec for.',
      },
      exits: {
        submit: exit<AskGoalPayload>({
          to: 'iterateRequirements',
          actions: assign(({ event }) => ({ goal: event.payload.goal })),
        }),
      },
    }),
    iterateRequirements: state<Ctx>({
      entryPrompt:
        'Iterate with the owner one requirement at a time. Ask them for the next ' +
        'requirement (or for clarification on what they last said), then record it. ' +
        'When the owner indicates they have no more, mark done to advance.',
      awaitsOwnerText: {
        messageToUser:
          'What is the next requirement? Describe it, including a measurable fit criterion. Reply "done" when there are no more.',
      },
      exits: {
        submit: exit<IteratePayload, Ctx>({
          when: [
            {
              guard: ({ event }) => event.payload.next.done === true,
              to: 'research',
            },
            {
              to: 'iterateRequirements',
              actions: assign({
                records: ({ context, event }) => {
                  const p = event.payload.next;
                  if (p.done) return context.records;
                  return [...context.records, p.requirement];
                },
              }),
            },
          ],
        }),
      },
    }),
    research: state<Ctx>({
      entryPrompt:
        "For each requirement gathered, spawn one Task subagent (general-purpose) to research feasibility, prior art, and conflicts with other requirements. Echo each subagent's output verbatim into the `notes` field rather than summarising. Submit the collected findings.",
      exits: {
        submit: exit<ResearchPayload>({
          to: 'flagIncompatibilities',
          actions: assign(({ event }) => ({ findings: event.payload.findings })),
        }),
      },
    }),
    flagIncompatibilities: state<Ctx>({
      entryPrompt:
        'Read the gathered requirements and findings. Identify any pairs or groups of requirements that conflict (overlapping scope, contradictory acceptance criteria, mutually exclusive dependencies). Submit the conflict list (empty if none).',
      exits: {
        submit: exit<FlagPayload>({
          to: 'probeMissingRequirements',
          actions: assign(({ event }) => ({ conflicts: event.payload.conflicts })),
        }),
      },
    }),
    probeMissingRequirements: state<Ctx>({
      entryPrompt:
        'Surface to the owner any gaps your research suggests (uncovered user paths, ' +
        'missing fit criteria, decisions not yet made). Capture any new requirements ' +
        'they confirm; submit the additions (empty if none).',
      awaitsOwnerText: {
        messageToUser:
          'Based on the research, are there any gaps we should cover before drafting — uncovered user paths, missing fit criteria, decisions not yet made? Confirm any new requirements to add.',
      },
      exits: {
        submit: exit<ProbePayload, Ctx>({
          to: 'presentDraft',
          actions: assign({
            records: ({ context, event }) => [...context.records, ...event.payload.additions],
          }),
        }),
      },
    }),
    presentDraft: { ...passive(), entry: renderArtifacts, always: { target: 'reviseWithOwner' } },
    reviseWithOwner: state<Ctx>({
      entryPrompt:
        'Show the owner the rendered `requirements.md` (read it from the run dir) and ' +
        'iterate edits with them. For each change the owner requests, submit one edit ' +
        '(op: add | remove | replace). When the owner is satisfied, mark done. The FSM ' +
        're-renders artifacts after every edit.',
      awaitsOwnerText: {
        messageToUser:
          'Here is the current draft (see requirements.md in the run dir). What edits do you want — add, remove, or replace any entries? Reply "done" when satisfied.',
      },
      exits: {
        submit: exit<RevisePayload, Ctx>({
          when: [
            {
              guard: ({ event }) => event.payload.next.done === true,
              to: 'reviewerPass',
            },
            {
              to: 'reviseWithOwner',
              actions: [
                assign({
                  records: ({ context, event }) => {
                    const p = event.payload.next;
                    if (p.done) return context.records;
                    const e = p.edit;
                    if (e.op === 'add') return [...context.records, e.requirement];
                    if (e.op === 'remove') return context.records.filter((r) => r.id !== e.id);
                    return context.records.map((r) => (r.id === e.id ? e.requirement : r));
                  },
                }),
                renderArtifacts,
              ],
            },
          ],
        }),
      },
    }),
    reviewerPass: state<Ctx>({
      entryPrompt:
        "Read the rendered `requirements.md` afresh as a devil's advocate. Look for: requirements without measurable fit criteria, vague language, hidden assumptions, missing edge cases, internal contradictions. Submit a verdict; if `rework`, your notes will be shown to the owner for another revision pass.",
      exits: {
        submit: exit<ReviewPayload>({
          when: [
            {
              guard: ({ event }) => event.payload.verdict === 'pass',
              to: 'finalize',
              actions: assign(({ event }) => ({
                reviewerVerdict: event.payload.verdict,
              })),
            },
            {
              to: 'reviseWithOwner',
              actions: assign(({ event }) => ({
                reviewerVerdict: event.payload.verdict,
              })),
            },
          ],
        }),
      },
    }),
    finalize: { ...terminal('success'), entry: renderArtifacts },
  },
});

export default machine;
