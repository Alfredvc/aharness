import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { pickEphemeralPort } from '../src/appServer/port.js';

function listenOnPort(port: number, host: string): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('pickEphemeralPort', () => {
  it('returns a port that can be rebound on the requested host', async () => {
    const host = '127.0.0.1';
    const port = await pickEphemeralPort(host);
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65_536);

    const server = await listenOnPort(port, host);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected rebound TCP server to expose an address object');
      }
      expect(address.port).toBe(port);
      expect(address.address).toBe(host);
    } finally {
      await closeServer(server);
    }
  });
});
