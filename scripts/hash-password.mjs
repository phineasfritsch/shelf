// Reads a password from stdin (never argv - argv shows up in `ps` and shell history) and prints the scrypt hash.
//   echo -n 'my password' | node scripts/hash-password.mjs
//   docker run --rm -i shelf node scripts/hash-password.mjs   (then type the password and press Ctrl-D)
// Use the printed value as PASSWORD_HASH (in compose, escape every $ as $$).
import { hashPasswordSync } from '../lib/password.js';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (!password) { process.stderr.write('hash-password: empty password on stdin\n'); process.exit(1); }
  process.stdout.write(hashPasswordSync(password) + '\n');
});
if (process.stdin.isTTY) process.stderr.write('Type the password, then press Enter and Ctrl-D:\n');
