/**
 * The sweeper's control socket: unlock, lock, status.
 *
 * Local only — a Unix socket readable by the sweeper's own user, or a named
 * pipe on Windows. Reaching it takes a shell on the server as that user, and
 * the passphrase still has to be right. Nothing about it listens on a network.
 *
 * One JSON object per line each way. `npm run keys:unlock` is the client.
 */

import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import net from 'node:net';

import type { KeyHolder } from './keys.ts';

const MAX_REQUEST_BYTES = 4096;
/** Paid after every wrong passphrase, on top of the key derivation itself. */
const FAILURE_DELAY_MS = 1000;

export interface ControlEvents {
  onChange: (state: 'locked' | 'unlocked', how: string) => void;
  log: (message: string, extra?: Record<string, unknown>) => void;
}

type Reply = { ok: true; state: string; hot_wallet?: string } | { ok: false; error: string };

async function handle(line: string, holder: KeyHolder, events: ControlEvents): Promise<Reply> {
  let request: { cmd?: unknown; passphrase?: unknown };
  try {
    request = JSON.parse(line) as typeof request;
  } catch {
    return { ok: false, error: 'Unreadable request' };
  }

  switch (request.cmd) {
    case 'status':
      return { ok: true, state: holder.state };

    case 'lock':
      holder.lock();
      events.onChange('locked', 'locked on request');
      return { ok: true, state: holder.state };

    case 'unlock': {
      if (typeof request.passphrase !== 'string' || request.passphrase === '') return { ok: false, error: 'No passphrase given' };
      const result = await holder.unlock(request.passphrase);
      if (!result.ok) {
        events.log('unlock refused', { reason: result.reason });
        await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
        return { ok: false, error: result.reason };
      }
      events.onChange('unlocked', 'unlocked with the passphrase');
      return { ok: true, state: holder.state, hot_wallet: holder.keys?.hotWallet.address ?? '' };
    }

    default:
      return { ok: false, error: 'Unknown command' };
  }
}

/** Remove a socket left behind by a previous run — and only a socket. */
function clearStaleSocket(socketPath: string): void {
  if (process.platform === 'win32') return;
  try {
    if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath);
  } catch {
    // Nothing there; nothing to clear.
  }
}

export function startControlServer(socketPath: string, holder: KeyHolder, events: ControlEvents): Promise<net.Server> {
  clearStaleSocket(socketPath);

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.end(JSON.stringify({ ok: false, error: 'Request too large' }) + '\n');
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = '';
      socket.pause();
      void handle(line, holder, events).then((reply) => socket.end(JSON.stringify(reply) + '\n'));
    });
  });

  // Owner only, from the moment the socket exists: created under a tight
  // umask rather than loosened and then fixed, which would leave a window.
  const previousUmask = process.platform === 'win32' ? null : process.umask(0o177);
  return new Promise((resolve, reject) => {
    const restore = () => { if (previousUmask !== null) process.umask(previousUmask); };
    server.once('error', (error) => { restore(); reject(error); });
    server.listen(socketPath, () => {
      restore();
      if (process.platform !== 'win32') chmodSync(socketPath, 0o600);
      server.removeAllListeners('error');
      server.on('error', (error) => events.log('control socket error', { error: error.message }));
      resolve(server);
    });
  });
}
