import type { AharnessOps } from '../state/aharnessOps.js';
import type { ChoiceMeta, RunCtx } from '../types.js';
import type { ActorHost } from './actorHost.js';

export type ActiveChoiceData =
  | {
      readonly ok: true;
      readonly state: string;
      readonly visitCount: number;
      readonly question: string;
      readonly labels: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly error: string };

export type ChoiceValidationResult =
  | { readonly ok: true; readonly state: string; readonly label: string }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error:
        | 'state-not-choice'
        | 'owner-choice-state-mismatch'
        | 'owner-choice-visit-mismatch'
        | 'invalid-owner-choice-label'
        | 'owner-choice-question-error';
      readonly message?: string;
    };

export type ChoiceCommitResult =
  | {
      readonly ok: true;
      readonly from: string;
      readonly to: string;
      readonly nextContext: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly message?: string;
    };

export function activeChoiceData(host: ActorHost): ActiveChoiceData {
  const state = host.currentStateId();
  const meta = host.currentMeta();
  if (meta?.kind !== 'choice') {
    return { ok: false, error: `active state '${state}' is not a choice state` };
  }
  return choiceDataFromMeta(state, meta, host.currentContext() as RunCtx);
}

export function validateOwnerChoiceReply(
  host: ActorHost,
  payload: { readonly state: string; readonly visitCount: number; readonly label: string },
): ChoiceValidationResult {
  const state = host.currentStateId();
  const meta = host.currentMeta();
  if (meta?.kind !== 'choice') {
    return { ok: false, status: 409, error: 'state-not-choice' };
  }
  if (payload.state !== state) {
    return { ok: false, status: 409, error: 'owner-choice-state-mismatch' };
  }
  const data = choiceDataFromMeta(state, meta, host.currentContext() as RunCtx);
  if (!data.ok) {
    return {
      ok: false,
      status: 500,
      error: 'owner-choice-question-error',
      message: data.error,
    };
  }
  if (payload.visitCount !== data.visitCount) {
    return { ok: false, status: 409, error: 'owner-choice-visit-mismatch' };
  }
  if (!data.labels.includes(payload.label)) {
    return { ok: false, status: 400, error: 'invalid-owner-choice-label' };
  }
  return { ok: true, state, label: payload.label };
}

export async function commitOwnerChoice(
  host: ActorHost,
  args: { readonly state: string; readonly label: string; readonly ops?: AharnessOps },
): Promise<ChoiceCommitResult> {
  const from = host.currentStateId();
  const dry = host.dryRunChoice(args.state, args.label);
  if (!dry.ok) {
    return {
      ok: false,
      status: 500,
      error: 'owner-choice-projection-failed',
      message: dry.error,
    };
  }
  const target = choiceTarget(host, args.state, args.label);
  const embeddedPrepared = await host.prepareEmbeddedFinalCommit({
    sourceStateId: args.state,
    target,
    context: dry.nextContext,
    event: { type: `OWNER_CHOICE__${args.state}`, payload: { label: args.label } },
    ...(args.ops !== undefined ? { ops: args.ops } : {}),
  });
  if (!embeddedPrepared.ok) {
    return {
      ok: false,
      status: 500,
      error: 'owner-choice-embedded-final-failed',
      message: embeddedPrepared.error,
    };
  }
  host.commitChoice(
    args.state,
    args.label,
    embeddedPrepared.matched ? embeddedPrepared.nextContext : undefined,
  );
  return {
    ok: true,
    from,
    to: host.currentStateId(),
    nextContext: embeddedPrepared.matched ? embeddedPrepared.nextContext : dry.nextContext,
  };
}

function choiceDataFromMeta(state: string, meta: ChoiceMeta, context: RunCtx): ActiveChoiceData {
  let question: string;
  try {
    question = typeof meta.question === 'string' ? meta.question : meta.question(context);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const visits = context.__aharness_visitCount;
  const visitCount = visits !== undefined && typeof visits[state] === 'number' ? visits[state] : 0;
  return {
    ok: true,
    state,
    visitCount,
    question,
    labels: meta.options.map((option) => option.label),
  };
}

function choiceTarget(host: ActorHost, state: string, label: string): string | undefined {
  const meta = host.metaForState(state);
  if (meta?.kind !== 'choice') return undefined;
  return meta.options.find((option) => option.label === label)?.to;
}
