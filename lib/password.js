// Password hashing with node:crypto scrypt. Pure functions, no I/O.
// Hash string format: scrypt$<N>$<r>$<p>$<salt b64url 16B>$<key b64url 32B>
import { randomBytes, scrypt as scryptCb, scryptSync, timingSafeEqual } from 'node:crypto';

const DEFAULT = { N: 32768, r: 8, p: 1 };
const KEYLEN = 32;

function b64(buf) { return Buffer.from(buf).toString('base64url'); }

// `salt` (≥ 8 bytes) is optional: a fresh random 16-byte salt is the default. config.js passes a persisted salt for
// plaintext PASSWORD sources so the hash string — and the session fingerprint derived from it — is stable across restarts.
export function hashPasswordSync(password, { N = DEFAULT.N, r = DEFAULT.r, p = DEFAULT.p, salt } = {}) {
  const s = salt ? Buffer.from(salt) : randomBytes(16);
  if (s.length < 8) throw new Error('salt must be at least 8 bytes');
  const key = scryptSync(String(password), s, KEYLEN, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${b64(s)}$${b64(key)}`;
}

function scryptAsync(password, salt, params) {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEYLEN, { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export function parseHash(str) {
  if (typeof str !== 'string') return null;
  const parts = str.trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(N) || N < 1024 || (N & (N - 1)) !== 0 || !Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length < 8 || key.length !== KEYLEN) return null;
  return { N, r, p, salt, key };
}

export function isHashString(str) { return parseHash(str) !== null; }

// A dummy hash used so that a malformed stored hash still costs a full scrypt (constant-time-ish path).
const DUMMY = parseHash(hashPasswordSync('dummy-password-never-matches'));

// Resolves true/false. Always performs one scrypt of the stored parameters (or the dummy's).
export async function verifyPassword(password, hashString) {
  const parsed = parseHash(hashString) || DUMMY;
  const key = await scryptAsync(String(password ?? ''), parsed.salt, parsed);
  const ok = timingSafeEqual(key, parsed.key);
  return parsed === DUMMY ? false : ok;
}

export function verifyPasswordSync(password, hashString) {
  const parsed = parseHash(hashString) || DUMMY;
  const key = scryptSync(String(password ?? ''), parsed.salt, KEYLEN, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: 256 * 1024 * 1024 });
  const ok = timingSafeEqual(key, parsed.key);
  return parsed === DUMMY ? false : ok;
}

export function generatePassword() {
  return randomBytes(15).toString('base64url'); // 20 chars
}
