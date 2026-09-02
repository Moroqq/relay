import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertEndpointAllowed, EndpointRejected } from './endpoint.ts';

const PRODUCTION = { requireHttps: true, allowPrivate: false };
const DEVELOPMENT = { requireHttps: false, allowPrivate: true };

test('an ordinary merchant endpoint is allowed', () => {
  const url = assertEndpointAllowed('https://api.marketplace-b.io/relay/hook', PRODUCTION);
  assert.equal(url.hostname, 'api.marketplace-b.io');
  assert.equal(url.pathname, '/relay/hook');
});

test('production refuses to reach inside our own network', () => {
  // The worker runs in our infrastructure, so a request it makes is one our
  // firewall trusts. A merchant must not be able to aim that at us.
  const inside = [
    'http://localhost:5433/',
    'http://127.0.0.1:6380/',
    'http://10.0.0.5/hook',
    'http://192.168.1.10/hook',
    'http://172.16.4.2/hook',
    'http://[::1]/hook',
    'https://db.internal/hook',
    'https://cache.local/hook',
  ];
  for (const endpoint of inside) {
    assert.throws(() => assertEndpointAllowed(endpoint, PRODUCTION), EndpointRejected, endpoint);
  }
});

test('the cloud metadata address is refused', () => {
  // 169.254.169.254 hands out cloud credentials to anything that asks from
  // inside the instance. It is the first thing an attacker tries.
  assert.throws(() => assertEndpointAllowed('http://169.254.169.254/latest/meta-data/', PRODUCTION), EndpointRejected);
  assert.throws(() => assertEndpointAllowed('http://metadata.google.internal/', PRODUCTION), EndpointRejected);
});

test('production requires https', () => {
  assert.throws(() => assertEndpointAllowed('http://example.com/hook', PRODUCTION), /must use https/);
  assert.doesNotThrow(() => assertEndpointAllowed('https://example.com/hook', PRODUCTION));
});

test('non-http schemes are refused whatever the policy', () => {
  for (const endpoint of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/']) {
    assert.throws(() => assertEndpointAllowed(endpoint, DEVELOPMENT), EndpointRejected, endpoint);
  }
});

test('development can point at localhost, because it always does', () => {
  assert.doesNotThrow(() => assertEndpointAllowed('http://127.0.0.1:4001/hook', DEVELOPMENT));
  assert.doesNotThrow(() => assertEndpointAllowed('http://localhost:4001/hook', DEVELOPMENT));
});

test('nonsense is refused rather than guessed at', () => {
  for (const endpoint of ['', 'not a url', '//example.com', 'example.com/hook']) {
    assert.throws(() => assertEndpointAllowed(endpoint, PRODUCTION), EndpointRejected, endpoint);
  }
});

test('a public address that merely looks private is allowed', () => {
  // 172.32 is outside the private 172.16-172.31 block, and 11.x is public.
  assert.doesNotThrow(() => assertEndpointAllowed('https://172.32.0.1/hook', PRODUCTION));
  assert.doesNotThrow(() => assertEndpointAllowed('https://11.0.0.1/hook', PRODUCTION));
});
