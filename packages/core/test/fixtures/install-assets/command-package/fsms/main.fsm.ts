import { aharness, final } from '@aharness/core';
import {
  dependencyAssetText,
  dependencyAssetUrl,
} from '@scope/asset-dependency/src/asset-helper.js';

const commandText = aharness.getAssetText('prompts/main.md').trim();
const commandUrl = aharness.getAssetUrl('prompts/main.md').href;
const dependencyText = dependencyAssetText().trim();
const dependencyUrl = dependencyAssetUrl().href;

export default aharness.machine({
  id: `asset-command-${commandText}-${dependencyText}`,
  initial: 'done',
  context: () => ({
    commandText,
    commandUrl,
    dependencyText,
    dependencyUrl,
  }),
  states: {
    done: final({ outcome: 'success' }),
  },
});
