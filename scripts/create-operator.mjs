/**
 * Create a console operator.
 *
 *   npm run console:create-operator -- --email you@example.com --name "Your Name" --role admin
 *
 * Prints a generated password and the second-factor secret, once. Neither can
 * be read back afterwards: the password is stored only as a hash, and the
 * secret only sealed under CONSOLE_SECRET_KEY. Run it in your own terminal, so
 * the password is never pasted anywhere else.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePassword, hashPassword, newTotpSecret, otpauthUri, parseSecretboxKey, seal } from '@relay/auth';
import { closePool, createOperator } from '@relay/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? undefined : args[i + 1];
};

const email = arg('email');
const name = arg('name');
const role = arg('role') ?? 'operator';

if (!email || !name) {
  console.error('Usage: npm run console:create-operator -- --email you@example.com --name "Your Name" [--role admin|operator|viewer]');
  process.exit(1);
}
if (!['admin', 'operator', 'viewer'].includes(role)) {
  console.error('Role must be admin, operator or viewer.');
  process.exit(1);
}

const key = parseSecretboxKey(process.env.CONSOLE_SECRET_KEY);
const password = generatePassword();
const secret = newTotpSecret();

const operator = await createOperator({
  email,
  name,
  role,
  passwordHash: await hashPassword(password),
  totpSecretSealed: seal(secret, key),
});

const grouped = secret.match(/.{1,4}/g).join(' ');
console.log('');
console.log('  Operator created: ' + operator.name + ' <' + operator.email + '>, role ' + operator.role);
console.log('');
console.log('  Password:  ' + password);
console.log('');
console.log('  Add to an authenticator app (Google Authenticator, 1Password, Aegis...):');
console.log('    account: Relay Console');
console.log('    key:     ' + grouped);
console.log('    type:    time-based, 6 digits, 30 seconds');
console.log('');
console.log('  Or open this link on the phone:');
console.log('    ' + otpauthUri(secret, operator.email));
console.log('');
console.log('  Shown once. Store the password in a password manager now.');
console.log('');

await closePool();
