import { aharness as h } from '@aharness/core';

export function dependencyAssetText(): string {
  return h.getAssetText('prompts/dependency.md');
}

export function dependencyAssetUrl(): URL {
  return h.getAssetUrl('prompts/dependency.md');
}
