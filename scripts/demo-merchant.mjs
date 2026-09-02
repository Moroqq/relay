/**
 * A stand-in for a merchant's server: receives webhooks, verifies the
 * signature the way a real integration would, and prints what arrived.
 *
 * This is also the reference implementation we would hand to merchants.
 */
import http from 'node:http';
import { verifySignature, SIGNATURE_HEADER } from '@relay/core';

const port = Number(process.env.MERCHANT_PORT ?? 4001);
const secret = process.env.MERCHANT_SECRET ?? '';

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const signature = req.headers[SIGNATURE_HEADER] ?? '';
      const valid = secret === '' ? null : verifySignature(body, secret, signature);

      let summary = body.slice(0, 120);
      try {
        const parsed = JSON.parse(body);
        summary = `${parsed.event}  ${parsed.data?.id}  ${parsed.data?.state}  net=${parsed.data?.net_amount} fee=${parsed.data?.fee_amount}`;
      } catch {}

      console.log(
        `[merchant] signature ${valid === null ? 'unchecked' : valid ? 'VALID' : 'INVALID'}  ${summary}`,
      );

      // A merchant must answer 2xx quickly and do the real work afterwards,
      // or every slow order-fulfilment call becomes a webhook timeout.
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`[merchant] listening on :${port}`));
