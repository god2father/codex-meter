import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
if (!root) throw new Error('Usage: node simulator.mjs <community-simulator-checkout>');
const { createAppServer } = await import(pathToFileURL(path.resolve(root, 'server.mjs')));
const server = createAppServer({
  allowLocalFirmwareUpload: true,
  analytics: false,
  networkBridge: {
    allowPrivate: true,
    createTcpConnection(options) {
      if (options.host === '192.168.4.1' && options.port === 8765) {
        return net.createConnection({ ...options, host: '127.0.0.1' });
      }
      return net.createConnection(options);
    },
  },
});
server.listen(4190, '127.0.0.1', () => console.log('Passport Simulator: http://127.0.0.1:4190'));
process.on('SIGTERM', () => server.close());
