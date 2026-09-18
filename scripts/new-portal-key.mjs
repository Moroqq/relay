/**
 * Generate PORTAL_SECRET_KEY. It opens every merchant's second-factor secret,
 * so it belongs in the environment of the portal process and nowhere else.
 */
import { newSecretboxKey } from '@relay/auth';
console.log('\n  PORTAL_SECRET_KEY=' + newSecretboxKey() + '\n');
console.log('  Losing it locks every merchant out: their second factors can no longer be read.');
console.log('  Keep a copy wherever the other production secrets are kept.\n');
