/**
 * Generate CONSOLE_SECRET_KEY. It opens every operator's second-factor secret,
 * so it belongs in the environment of the console process and nowhere else —
 * not in the database, not in the repository.
 */
import { newSecretboxKey } from '@relay/auth';
console.log('\n  CONSOLE_SECRET_KEY=' + newSecretboxKey() + '\n');
console.log('  Losing it locks every operator out: their second factors can no longer be read.');
console.log('  Keep a copy wherever the other production secrets are kept.\n');
