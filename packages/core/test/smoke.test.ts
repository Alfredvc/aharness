import { describe, expect, it } from 'vitest';
import * as coreSdk from '../src/index.js';

describe('@aharness/core barrel', () => {
  it('exports the package version constant', () => {
    expect(typeof coreSdk.PACKAGE_NAME).toBe('string');
    expect(coreSdk.PACKAGE_NAME).toBe('@aharness/core');
  });
});
