/**
 * Entry point for the operations console.
 */

import { closePool } from '@relay/db';

import { loadConsoleConfig } from './config.ts';
import { buildConsoleServer } from './server.ts';

const config = loadConsoleConfig();
const app = buildConsoleServer(config, { logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(closePool).then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
app.log.info('Relay console on ' + config.host + ':' + config.port + (config.secureCookies ? '' : ' (insecure cookies: development only)'));
