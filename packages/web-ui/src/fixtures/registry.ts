// Maps a fixture id (chosen via the ?fsm=<id> URL param) to the topology,
// scene list, and run-meta the UI should boot against. The default fixture
// is the requirement-spec walkthrough; `auto` exercises a fully autonomous
// retry loop with no owner interaction.

import type { Topology } from '../types/topology.js';
import type { RunMeta } from '../types/events.js';
import type { Scene } from './script.js';
import { topology as requirementTopology } from './topology.js';
import { topology as autoTopology } from './topology-auto.js';
import { topology as embedTopology, scenes as embedScenes } from './topology-embed.js';
import { scenes as requirementScenes } from './script.js';
import { scenes as autoScenes } from './script-auto.js';

export type FixtureId = 'requirement-spec' | 'auto' | 'embed';

export type Fixture = {
  id: FixtureId;
  topology: Topology;
  scenes: Scene[];
  runMeta: Pick<RunMeta, 'fsmFile' | 'fsmHash6' | 'runId'>;
};

const FIXTURES: Record<FixtureId, Fixture> = {
  'requirement-spec': {
    id: 'requirement-spec',
    topology: requirementTopology,
    scenes: requirementScenes,
    runMeta: {
      fsmFile: 'examples/requirement-spec.fsm.ts',
      fsmHash6: '5d2c0a',
      runId: '5d2c0a-9b7f12',
    },
  },
  auto: {
    id: 'auto',
    topology: autoTopology,
    scenes: autoScenes,
    runMeta: {
      fsmFile: 'examples/autonomous-repair.fsm.ts',
      fsmHash6: '7b41ec',
      runId: '7b41ec-2d09a4',
    },
  },
  embed: {
    id: 'embed',
    topology: embedTopology,
    scenes: embedScenes,
    runMeta: {
      fsmFile: 'examples/embed-demo.fsm.ts',
      fsmHash6: '91e2bc',
      runId: '91e2bc-c34402',
    },
  },
};

export function resolveFixture(idRaw: string | null | undefined): Fixture {
  if (idRaw && idRaw in FIXTURES) return FIXTURES[idRaw as FixtureId];
  return FIXTURES['requirement-spec'];
}

export function readFixtureIdFromLocation(): FixtureId {
  const location = (globalThis as { location?: { search?: string } }).location;
  if (!location) return 'requirement-spec';
  const param = new URLSearchParams(location.search ?? '').get('fsm');
  return resolveFixture(param).id;
}
