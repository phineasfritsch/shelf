// Minimal stdout logger. Text lines by default, JSON lines with LOG_JSON=1.
// Never pass secrets (passwords, session tokens, cookies) into fields.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function fmtField(v) {
  if (v instanceof Error) return JSON.stringify(v.stack || v.message);
  if (typeof v === 'string') return /[\s"=]/.test(v) ? JSON.stringify(v) : v;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function createLogger({ json = false, level = 'info', stream = process.stdout, name } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    const ts = new Date().toISOString();
    if (json) {
      const rec = { ts, level: lvl, msg, ...(name ? { name } : {}), ...fields };
      if (rec.err instanceof Error) rec.err = { message: rec.err.message, stack: rec.err.stack };
      stream.write(JSON.stringify(rec) + '\n');
      return;
    }
    let line = `${ts} ${lvl.toUpperCase().padEnd(5)} ${name ? name + ': ' : ''}${msg}`;
    for (const [k, v] of Object.entries(fields || {})) line += ` ${k}=${fmtField(v)}`;
    stream.write(line + '\n');
  };
  const logger = {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (childName) => createLogger({ json, level, stream, name: name ? `${name}.${childName}` : childName }),
  };
  return logger;
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLogger; } };
