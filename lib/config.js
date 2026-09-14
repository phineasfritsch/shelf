// Environment parsing and validation. Read once at boot. Invalid values exit(1) with a one-line reason.
// Overrides (from tests / start(overrides)) take precedence over process.env.
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashPasswordSync, isHashString, generatePassword } from './password.js';

export class ConfigError extends Error {}

const DEFAULTS = {
  PORT: '8080',
  HOST: '0.0.0.0',
  DATA_DIR: '/data',
  SESSION_DAYS: '365',
  COOKIE_SECURE: 'auto',
  TRUST_PROXY: '0',
  ALLOWED_ORIGINS: '',
  FILE_TTL_HOURS: '168',
  MAX_FILE_MB: '2048',
  MAX_STORAGE_MB: '0',
  MAX_TEXT_KB: '2048',
  SWEEP_INTERVAL_SEC: '60',
  LOGIN_MAX_FAILS: '5',
  LOGIN_WINDOW_MIN: '15',
  SHUTDOWN_TIMEOUT_SEC: '20',
  APP_NAME: 'Shelf',
  LOG_JSON: '0',
};

function num(name, raw, { min = 0, max = Infinity, integer = false } = {}) {
  const v = Number(raw);
  if (raw === '' || !Number.isFinite(v)) throw new ConfigError(`${name} must be a number, got ${JSON.stringify(raw)}`);
  if (integer && !Number.isInteger(v)) throw new ConfigError(`${name} must be an integer, got ${raw}`);
  if (v < min || v > max) throw new ConfigError(`${name} must be between ${min} and ${max}, got ${raw}`);
  return v;
}

function bool(name, raw) {
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(s)) return false;
  throw new ConfigError(`${name} must be 0/1/true/false, got ${JSON.stringify(raw)}`);
}

// Salt for plaintext password sources (PASSWORD, or PASSWORD_FILE without a scrypt$ prefix), persisted at
// DATA_DIR/password.salt. auth.js fingerprints the *hash string* (pwfp) and revokes every session when it changes;
// with a fresh salt per boot that fingerprint would change on every restart and `docker compose restart` would log
// every device out. A stable salt means only an actual password change does (SPEC §3). A salt is not a secret, so the
// file needs no more protection than password.hash gets; a missing or corrupt file is simply regenerated.
function loadOrCreateSalt(dataDir, warnings) {
  const file = join(dataDir, 'password.salt');
  if (existsSync(file)) {
    let raw;
    try { raw = readFileSync(file, 'utf8').trim(); } catch (e) { throw new ConfigError(`${file} cannot be read: ${e.message}`); }
    const salt = Buffer.from(raw, 'base64url');
    if (/^[A-Za-z0-9_-]{22}$/.test(raw) && salt.length === 16) return salt;
    warnings.push(`auth: ${file} is not a valid salt, regenerating it (every device is logged out once)`);
  }
  const salt = randomBytes(16);
  try { writeFileSync(file, salt.toString('base64url') + '\n', { mode: 0o600 }); }
  catch (e) { throw new ConfigError(`${file} cannot be written: ${e.message}`); }
  return salt;
}

// Resolution order: PASSWORD_HASH → PASSWORD_FILE → PASSWORD → DATA_DIR/password.hash → generate.
function resolvePassword(get, dataDir, warnings) {
  const hashFile = join(dataDir, 'password.hash');
  const fromHash = get('PASSWORD_HASH');
  if (fromHash) {
    if (!isHashString(fromHash)) throw new ConfigError('PASSWORD_HASH is not a valid scrypt$... string (generate one with `npm run hash-password`)');
    return { hash: fromHash.trim(), source: 'PASSWORD_HASH' };
  }
  const file = get('PASSWORD_FILE');
  if (file) {
    let content;
    try { content = readFileSync(file, 'utf8').trim(); } catch (e) { throw new ConfigError(`PASSWORD_FILE ${file} cannot be read: ${e.message}`); }
    if (!content) throw new ConfigError(`PASSWORD_FILE ${file} is empty`);
    if (content.startsWith('scrypt$')) {
      if (!isHashString(content)) throw new ConfigError(`PASSWORD_FILE ${file} contains an invalid scrypt hash`);
      return { hash: content, source: 'PASSWORD_FILE (hash)' };
    }
    return { hash: hashPasswordSync(content, { salt: loadOrCreateSalt(dataDir, warnings) }), source: 'PASSWORD_FILE (plaintext)' };
  }
  const plain = get('PASSWORD');
  if (plain !== undefined && plain !== '') {
    warnings.push('auth: using plaintext PASSWORD, prefer PASSWORD_HASH (npm run hash-password)');
    const hash = hashPasswordSync(plain, { salt: loadOrCreateSalt(dataDir, warnings) });
    delete process.env.PASSWORD;
    return { hash, source: 'PASSWORD (plaintext, hashed in memory)' };
  }
  if (existsSync(hashFile)) {
    const content = readFileSync(hashFile, 'utf8').trim();
    if (!isHashString(content)) throw new ConfigError(`${hashFile} exists but is not a valid scrypt hash; delete it to regenerate`);
    return { hash: content, source: hashFile };
  }
  const generated = generatePassword();
  const hash = hashPasswordSync(generated);
  writeFileSync(hashFile, hash + '\n', { mode: 0o600 });
  return { hash, source: 'generated', generatedPassword: generated, hashFile };
}

function ensureDataDir(dataDir) {
  try { mkdirSync(dataDir, { recursive: true }); } catch (e) { throw new ConfigError(`DATA_DIR ${dataDir} cannot be created: ${e.message}`); }
  let st;
  try { st = statSync(dataDir); } catch (e) { throw new ConfigError(`DATA_DIR ${dataDir} is not accessible: ${e.message}`); }
  if (!st.isDirectory()) throw new ConfigError(`DATA_DIR ${dataDir} is not a directory`);
  const probe = join(dataDir, `.write-test-${process.pid}`);
  try { writeFileSync(probe, 'ok'); unlinkSync(probe); }
  catch {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'current user';
    throw new ConfigError(`DATA_DIR ${dataDir} is not writable by uid ${uid} (for a bind mount: chown 1000:1000 the directory, or set user: in compose)`);
  }
  for (const sub of ['files', 'tmp']) mkdirSync(join(dataDir, sub), { recursive: true });
}

export function loadConfig(overrides = {}, env = process.env) {
  const warnings = [];
  const get = (name) => {
    if (overrides[name] !== undefined) return overrides[name] === null ? undefined : String(overrides[name]);
    const v = env[name];
    return v === undefined ? undefined : v;
  };
  const getd = (name) => get(name) ?? DEFAULTS[name];

  const dataDir = resolve(getd('DATA_DIR'));
  ensureDataDir(dataDir);

  const allowedOrigins = new Set(getd('ALLOWED_ORIGINS').split(',').map(s => s.trim()).filter(Boolean));
  for (const o of allowedOrigins) {
    try { const u = new URL(o); if (u.origin !== o) throw new Error(); } catch { throw new ConfigError(`ALLOWED_ORIGINS entry ${JSON.stringify(o)} must be a full origin like https://shelf.example.com`); }
  }
  const cookieSecureRaw = getd('COOKIE_SECURE').trim().toLowerCase();
  let cookieSecure;
  if (cookieSecureRaw === 'auto') cookieSecure = 'auto';
  else cookieSecure = bool('COOKIE_SECURE', cookieSecureRaw);

  const cfg = {
    port: num('PORT', getd('PORT'), { min: 0, max: 65535, integer: true }),
    host: getd('HOST'),
    dataDir,
    sessionDays: num('SESSION_DAYS', getd('SESSION_DAYS'), { min: 0.0001, max: 3650 }),
    cookieSecure,
    trustProxy: bool('TRUST_PROXY', getd('TRUST_PROXY')),
    allowedOrigins,
    fileTtlHours: num('FILE_TTL_HOURS', getd('FILE_TTL_HOURS'), { min: 0, max: 87600 }),
    maxFileMb: num('MAX_FILE_MB', getd('MAX_FILE_MB'), { min: 0.001, max: 1e6 }),
    maxStorageMb: num('MAX_STORAGE_MB', getd('MAX_STORAGE_MB'), { min: 0, max: 1e9 }),
    maxTextKb: num('MAX_TEXT_KB', getd('MAX_TEXT_KB'), { min: 1, max: 1e6 }),
    sweepIntervalSec: num('SWEEP_INTERVAL_SEC', getd('SWEEP_INTERVAL_SEC'), { min: 0.1, max: 86400 }),
    loginMaxFails: num('LOGIN_MAX_FAILS', getd('LOGIN_MAX_FAILS'), { min: 1, max: 1000, integer: true }),
    loginWindowMin: num('LOGIN_WINDOW_MIN', getd('LOGIN_WINDOW_MIN'), { min: 0.01, max: 1e5 }),
    shutdownTimeoutSec: num('SHUTDOWN_TIMEOUT_SEC', getd('SHUTDOWN_TIMEOUT_SEC'), { min: 0, max: 3600 }),
    appName: getd('APP_NAME').trim() || 'Shelf',
    logJson: bool('LOG_JSON', getd('LOG_JSON')),
    // test/internal knobs (not documented env vars)
    snapshotQuietMs: overrides.snapshotQuietMs ?? 30000,
    warnings,
  };
  if (cfg.appName.length > 40) throw new ConfigError('APP_NAME must be 40 characters or fewer');

  const pw = resolvePassword(get, dataDir, warnings);
  cfg.passwordHash = pw.hash;
  cfg.passwordSource = pw.source;
  if (pw.generatedPassword) { cfg.generatedPassword = pw.generatedPassword; cfg.passwordHashFile = pw.hashFile; }

  // derived
  cfg.sessionMs = Math.round(cfg.sessionDays * 86400e3);
  cfg.fileTtlMs = cfg.fileTtlHours > 0 ? Math.round(cfg.fileTtlHours * 3600e3) : null;
  cfg.maxFileBytes = Math.round(cfg.maxFileMb * 1024 * 1024);
  cfg.maxStorageBytes = cfg.maxStorageMb > 0 ? Math.round(cfg.maxStorageMb * 1024 * 1024) : null;
  cfg.maxTextChars = Math.round(cfg.maxTextKb * 1024);
  cfg.loginWindowMs = Math.round(cfg.loginWindowMin * 60e3);
  cfg.dbFile = join(dataDir, 'shelf.db');
  cfg.filesDir = join(dataDir, 'files');
  cfg.tmpDir = join(dataDir, 'tmp');
  cfg.textMirrorFile = join(dataDir, 'text.txt');
  return cfg;
}

// Effective config for the boot log, secrets redacted.
export function describeConfig(cfg) {
  return {
    port: cfg.port, host: cfg.host, dataDir: cfg.dataDir, password: cfg.passwordSource,
    sessionDays: cfg.sessionDays, cookieSecure: cfg.cookieSecure, trustProxy: cfg.trustProxy,
    allowedOrigins: [...cfg.allowedOrigins].join(',') || '-',
    fileTtlHours: cfg.fileTtlHours, maxFileMb: cfg.maxFileMb, maxStorageMb: cfg.maxStorageMb || 'unlimited',
    maxTextKb: cfg.maxTextKb, sweepIntervalSec: cfg.sweepIntervalSec,
    loginMaxFails: cfg.loginMaxFails, loginWindowMin: cfg.loginWindowMin, shutdownTimeoutSec: cfg.shutdownTimeoutSec,
    appName: cfg.appName, logJson: cfg.logJson,
  };
}
