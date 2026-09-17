import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { TronClient, TronError, errorInBody } from './client.ts';

/** A stand-in node that answers each request from a script. */
async function scriptedNode(replies: string[]) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const body = replies[Math.min(calls, replies.length - 1)]!;
      calls += 1;
      // TronGrid reports throttling with HTTP 200, which is the whole problem.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  return {
    client: new TronClient({ baseUrl: `http://127.0.0.1:${port}`, maxAttempts: 3, timeoutMs: 5_000 }),
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const THROTTLED = JSON.stringify({
  Error: 'request rate exceeded the allowed_rps(3), and the query server is suspended for 1 s.',
});
const OWNER = '41' + 'aa'.repeat(20);
const TOKEN = '41' + 'bb'.repeat(20);

test('a throttling message inside a 200 response is recognised as an error', () => {
  const error = errorInBody(JSON.parse(THROTTLED));
  assert.ok(error instanceof TronError);
  assert.equal(error.retriable, true);
  // It waits for the suspension the node named, plus a little.
  assert.equal(error.retryAfterMs, 1_500);
});

test('an ordinary result is not mistaken for an error', () => {
  assert.equal(errorInBody({ constant_result: ['00'] }), null);
  assert.equal(errorInBody([]), null);
  assert.equal(errorInBody(null), null);
});

test('any other error from the node is surfaced and not retried', () => {
  const error = errorInBody({ Error: 'class org.tron.core.exception.BadItemException : invalid address' });
  assert.equal(error?.retriable, false);
});

test('being throttled no longer looks like an empty wallet', async () => {
  // The bug: a throttled balance read returned the error body as the result,
  // which has no constant_result, so the wallet read as holding nothing.
  const node = await scriptedNode([
    THROTTLED,
    JSON.stringify({ result: { result: true }, constant_result: ['0'.repeat(56) + '05f5e100'] }),
  ]);
  try {
    const started = Date.now();
    const balance = await node.client.readTokenBalance(TOKEN, OWNER);

    assert.equal(balance, 100_000_000n); // the real balance, after waiting out the suspension
    assert.equal(node.calls(), 2);
    assert.ok(Date.now() - started >= 1_400, 'retried before the named suspension had passed');
  } finally {
    await node.close();
  }
});

test('if throttling persists the caller gets an error, never a made-up empty result', async () => {
  const node = await scriptedNode([THROTTLED]);
  try {
    await assert.rejects(node.client.readTokenBalance(TOKEN, OWNER), /rate limited/);
    assert.equal(node.calls(), 3);
  } finally {
    await node.close();
  }
});
