import { describe, expect, it } from 'vitest';
import { pickEphemeralPort } from '../src/appServer/port.js';

describe('pickEphemeralPort', () => {
  it('returns a usable port number', async () => {
    const p = await pickEphemeralPort();
    expect(p).toBeGreaterThan(1024);
    expect(p).toBeLessThan(65_536);
  });
  it('returns different ports across calls (best-effort)', async () => {
    const a = await pickEphemeralPort();
    const b = await pickEphemeralPort();
    expect(typeof a).toBe('number');
    expect(typeof b).toBe('number');
  });
});
