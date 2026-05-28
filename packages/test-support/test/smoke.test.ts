import { describe, expect, it } from 'vitest';
import * as ts from '../src/index.js';

describe('@aharness/test-support barrel', () => {
  it('reports its package name', () => {
    expect(ts.PACKAGE_NAME).toBe('@aharness/test-support');
  });
});
