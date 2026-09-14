// Entry point. `node server.js` runs the app; tests import { start } and run it in-process on port 0.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, describeConfig, ConfigError } from './lib/config.js';
import { createLogger } from './lib/log.js';
import { openDb, SchemaError } from './lib/db.js';
import { createAuth } from './lib/auth.js';
import { createRouter, createHttpServer } from './lib/http.js';
import { createStatic } from './lib/static.js';
import { registerAuthRoutes } from './lib/routes-auth.js';
import { createDoc } from './lib/doc.js';
import { createFiles } from './lib/files.js';
import { registerFileRoutes } from './lib/routes-files.js';
import { registerUploadRoutes } from './lib/routes-uploads.js';
import { registerHistoryRoutes } from './lib/routes-history.js';
import { createWs } from './lib/ws.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

// start(overrides) → { port, host, cfg, log, db, auth, doc, files, ws, server, close(opts) }
// overrides: any env var name (PORT, DATA_DIR, PASSWORD, ...) plus test knobs { snapshotQuietMs, logger }.
export async function start(overrides = {}) {
  const cfg = loadConfig(overrides);
  const log = overrides.logger || createLogger({ json: cfg.logJson });
  for (const w of cfg.warnings) log.warn(w);
  log.info('config', describeConfig(cfg));
  if (cfg.generatedPassword) {
    process.stdout.write([
      '',
      '==================================================================',
      '  No password configured. Generated one for you:',
      '',
      `      ${cfg.generatedPassword}`,
      '',
      `  It is hashed at ${cfg.passwordHashFile} and will be reused on`,
      '  restart. To choose your own: PASSWORD_HASH=$(npm run -s hash-password)',
      '==================================================================',
      '', '',
    ].join('\n'));
    delete cfg.generatedPassword;
  }

  const db = openDb(cfg.dbFile);
  const auth = createAuth({ cfg, db, log: log.child('auth') });
  const doc = createDoc({ cfg, db, log: log.child('doc') });
  const files = createFiles({ cfg, db, log: log.child('files') });
  const staticServer = createStatic({ publicDir: join(ROOT, 'public'), log: log.child('static') });

  const router = createRouter();
  registerAuthRoutes({ router, cfg, auth, staticServer, log: log.child('auth') });
  registerFileRoutes({ router, cfg, files, log: log.child('files') });
  const uploads = registerUploadRoutes({ router, cfg, files, log: log.child('files') });
  registerHistoryRoutes({ router, cfg, doc, log: log.child('history') });

  const http = createHttpServer({
    cfg, log: log.child('http'), router, staticServer, auth,
    healthz: () => ({ files: files.count(), clients: ws.clientCount(), uptime: Math.round(process.uptime()) }),
  });
  const ws = createWs({ cfg, log: log.child('ws'), server: http.server, auth, doc, files });
  auth.onSessionsRevoked = (idHashes, reason) => ws.closeSessions(idHashes, reason);

  // Sweeper: expired files, stale sessions/attempts/tokens.
  const sweepMs = Math.round(cfg.sweepIntervalSec * 1000);
  const runSweep = () => {
    try { files.sweep(); auth.prune(); } catch (err) { log.error('sweep failed', { err }); }
  };
  files.reconcile();
  runSweep();
  const sweepTimer = setInterval(runSweep, sweepMs);
  sweepTimer.unref();

  await new Promise((resolve, reject) => {
    http.server.once('error', reject);
    http.server.listen(cfg.port, cfg.host, () => { http.server.off('error', reject); resolve(); });
  });
  const address = http.server.address();
  const port = typeof address === 'object' && address ? address.port : cfg.port;
  log.info('listening', { host: cfg.host, port, url: `http://${cfg.host === '0.0.0.0' || cfg.host === '::' ? 'localhost' : cfg.host}:${port}` });

  let closing = null;
  // Graceful shutdown: drain → stop accepting → say bye to sockets → flush doc → wait for uploads → close db.
  function close({ reason = 'shutdown', timeoutMs = cfg.shutdownTimeoutSec * 1000 } = {}) {
    if (closing) return closing;
    closing = (async () => {
      http.setDraining(true);
      clearInterval(sweepTimer);
      uploads.close();
      http.server.close();
      if (typeof http.server.closeIdleConnections === 'function') http.server.closeIdleConnections();
      ws.shutdown(reason);
      try { doc.flush(); } catch (err) { log.error('doc flush failed', { err }); }
      const deadline = Date.now() + timeoutMs;
      while (files.inFlight() > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      if (files.inFlight() > 0) log.warn('shutdown: giving up on in-flight uploads', { n: files.inFlight() });
      if (typeof http.server.closeAllConnections === 'function') http.server.closeAllConnections();
      try { doc.close(); } catch (err) { log.error('doc close failed', { err }); }
      try { db.close(); } catch (err) { log.error('db close failed', { err }); }
      log.info('stopped');
    })();
    return closing;
  }

  return { port, host: cfg.host, cfg, log, db, auth, doc, files, ws, server: http.server, http, staticServer, close };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:fs')).realpathSync(process.argv[1]);
if (isMain) {
  let app;
  try {
    app = await start();
  } catch (err) {
    if (err instanceof ConfigError || err instanceof SchemaError) { process.stderr.write(`error: ${err.message}\n`); process.exit(1); }
    throw err;
  }
  let exiting = false;
  const onSignal = (sig) => {
    if (exiting) { process.exit(1); }
    exiting = true;
    app.log.info('signal received, shutting down', { signal: sig });
    const hard = setTimeout(() => { app.log.warn('shutdown timed out, exiting'); process.exit(1); }, app.cfg.shutdownTimeoutSec * 1000 + 5000);
    hard.unref();
    app.close({ reason: 'shutdown' }).then(() => process.exit(0), (err) => { app.log.error('shutdown failed', { err }); process.exit(1); });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('uncaughtException', (err) => { app.log.error('uncaught exception', { err }); });
  process.on('unhandledRejection', (err) => { app.log.error('unhandled rejection', { err }); });
}
