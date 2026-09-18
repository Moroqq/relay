/**
 * Entry point for the merchant portal.
 */

import { closePool } from '@relay/db';

import { loadPortalConfig } from './config.ts';
import { buildPortalServer } from './server.ts';

const config = loadPortalConfig();
const app = buildPortalServer(config, { logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(closePool).then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
app.log.info('Relay portal on ' + config.host + ':' + config.port + (config.secureCookies ? '' : ' (insecure cookies: development only)'));
