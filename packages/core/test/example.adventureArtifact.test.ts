import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadFsm } from '../src/loader/index.js';
import { ensureRunDir } from '../src/run.js';
import { ActorHost } from '../src/runtime/actorHost.js';
import { createSubmitDispatcher } from '../src/runtime/dispatchSubmit.js';
import type { DynamicToolCallParams } from '../src/protocol/types.js';
import { getAharnessMeta, iterStates, stateKeyPath } from '../src/state.js';
import { writeArtifact } from '../src/artifact.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const adventurePath = path.resolve(repoRoot, 'examples/adventure.fsm.ts');

function call(args: unknown): DynamicToolCallParams {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    callId: 'call-1',
    tool: 'aharness_submit',
    arguments: JSON.stringify(args) as DynamicToolCallParams['arguments'],
  };
}

describe('adventure example artifact lifecycle', () => {
  it('runtime submit dispatcher writes adventure.md before terminal success', async () => {
    const loaded = await loadFsm({ filePath: adventurePath, repoRoot, noCache: true });
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'adventure-dispatch-'));
    try {
      const runDir = ensureRunDir('abcdef-123456', tempRoot);
      const artifactPath = path.join(runDir.artifactsDir, 'adventure.md');
      const host = new ActorHost(loaded.machine, undefined, { runDir, runId: runDir.runId });
      host.start();
      const artifactWrites: string[] = [];

      const dispatch = createSubmitDispatcher({
        host,
        machine: loaded.machine,
        sidecar: loaded.sidecar,
        flushSnapshot: () => {},
        composeActiveStateNudge: () => 'forest nudge',
        scheduleCrossStateDance: () => {},
        writeFinalArtifacts: async (terminalStateId, context) => {
          artifactWrites.push(terminalStateId);
          const meta = terminalMetaById(loaded.machine, terminalStateId);
          if (meta?.kind !== 'terminal') throw new Error(`missing terminal ${terminalStateId}`);
          for (const [relPath, render] of Object.entries(meta.artifacts ?? {})) {
            await writeArtifact(runDir, relPath, render(context ?? host.currentContext()));
          }
        },
      });

      const first = await dispatch(
        call({
          state: 'entrance',
          exit: 'submit',
          data: { scene: 'A mossy road splits three ways.' },
        }),
      );
      expect(first.success).toBe(true);
      expect(host.currentStateId()).toBe('entranceChoice');
      host.commitChoice('entranceChoice', 'Forest');
      expect(host.currentStateId()).toBe('forest');

      const second = await dispatch(
        call({
          state: 'forest',
          exit: 'submit',
          data: {
            scene: 'The hero follows foxfire beneath ancient branches.',
          },
        }),
      );
      expect(second.success).toBe(true);
      expect(host.currentStateId()).toBe('forestChoice');
      host.commitChoice('forestChoice', 'Bold');
      expect(host.currentStateId()).toBe('forestVictory');

      const third = await dispatch(
        call({
          state: 'forestVictory',
          exit: 'submit',
          data: {
            ending: 'A hidden crown glows in the roots.',
          },
        }),
      );

      expect(third.success).toBe(true);
      expect(third.contentItems).toEqual([
        { type: 'inputText', text: 'Run complete. Terminal: success.' },
      ]);
      expect(host.currentStateId()).toBe('victory');
      expect(artifactWrites).toEqual(['victory']);
      await expect(fs.access(artifactPath)).resolves.toBeUndefined();
      await expect(fs.readFile(artifactPath, 'utf8')).resolves.toContain('Outcome: **victory**');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses final artifacts instead of passive artifact writer states', async () => {
    const loaded = await loadFsm({ filePath: adventurePath, repoRoot, noCache: true });
    expect(stateIds(loaded.machine)).not.toContain('writeVictoryArtifact');
    expect(stateIds(loaded.machine)).not.toContain('writeDefeatArtifact');
    expect(terminalMetaById(loaded.machine, 'victory')?.artifacts).toHaveProperty('adventure.md');
    expect(terminalMetaById(loaded.machine, 'defeat')?.artifacts).toHaveProperty('adventure.md');
  });
});

function terminalMetaById(machine: Parameters<typeof iterStates>[0], stateId: string) {
  for (const node of iterStates(machine)) {
    if (stateKeyPath(node) === stateId) return getAharnessMeta(node);
  }
  return undefined;
}

function stateIds(machine: Parameters<typeof iterStates>[0]): string[] {
  return [...iterStates(machine)].map((node) => stateKeyPath(node));
}
