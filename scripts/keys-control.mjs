/**
 * Talk to a running sweeper through its control socket.
 *
 *   npm run keys:unlock    asks for the keystore passphrase; signing resumes
 *   npm run keys:lock      forgets the keys at once; payouts and sweeps stop
 *   npm run keys:status
 *
 * Run it on the server, as the user the sweeper runs as.
 */
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { askHidden } from './lib/prompt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const cmd = process.argv[2];
if (!['unlock', 'lock', 'status'].includes(cmd)) {
  console.error('Usage: node scripts/keys-control.mjs unlock|lock|status');
  process.exit(1);
}

/** Must match defaultControlSocket in services/sweeper/src/config.ts. */
function socketPath() {
  const explicit = process.env.KEYS_SOCKET?.trim();
  if (explicit) return explicit;
  if (process.platform === 'win32') return '\\\\.\\pipe\\relay-sweeper-keys';
  const keystore = process.env.KEYSTORE_PATH?.trim();
  if (!keystore) {
    console.error('Set KEYSTORE_PATH (or KEYS_SOCKET) as the sweeper has it.');
    process.exit(1);
  }
  return path.join(path.dirname(path.resolve(keystore)), 'sweeper.sock');
}

function send(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath());
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', (chunk) => { buffer += chunk; });
    socket.on('end', () => {
      try { resolve(JSON.parse(buffer)); } catch { reject(new Error('The sweeper sent an unreadable reply')); }
    });
    socket.on('error', (error) => {
      reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
        ? new Error('No sweeper is listening. Is it running, with KEYSTORE_PATH set?')
        : error);
    });
  });
}

try {
  const request = { cmd };
  if (cmd === 'unlock') request.passphrase = (await askHidden('Keystore passphrase (hidden): ')).trim();
  const reply = await send(request);
  if (!reply.ok) {
    console.error('Refused: ' + reply.error);
    process.exit(1);
  }
  if (cmd === 'unlock') console.log('Unlocked. Signing for hot wallet ' + reply.hot_wallet + '; payouts and sweeps resume.');
  else if (cmd === 'lock') console.log('Locked. The keys are gone from memory; payouts and sweeps have stopped.');
  else console.log('Signing is ' + reply.state + '.');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
