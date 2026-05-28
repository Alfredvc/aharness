import { createServer } from 'node:net';

export function pickEphemeralPort(host: string = '127.0.0.1'): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, host, () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('port: failed to obtain address'));
        return;
      }
      const port = addr.port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
