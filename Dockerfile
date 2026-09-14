# Shelf — single-stage image. Nothing to build: the browser code is served as-is
# from public/ (yjs/qrcode are pre-vendored and committed), so the image is just
# Node + ws + yjs + the source tree. ~65 MB.
FROM node:26-alpine

ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app

# Dependencies first so the layer is cached across source-only changes.
# --omit=dev keeps esbuild/qrcode-generator (only needed by `npm run vendor`/`icons`) out of the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

# The app runs as the unprivileged `node` user (uid/gid 1000). Pre-create /data owned by it so a
# named volume inherits the ownership on first use. For a bind mount, chown the host directory
# to 1000:1000 or set `user:` in compose (see README).
RUN mkdir -p /data && chown node:node /data
USER node

VOLUME ["/data"]
EXPOSE 8080

# busybox wget exits non-zero on 503, which /healthz returns while draining after SIGTERM,
# so the container turns unhealthy before its sockets close. Shell form so $PORT is honoured
# if you override it; HOST must still be reachable on the loopback (0.0.0.0 or 127.0.0.1).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1

# server.js handles SIGTERM: stops accepting, says bye to WebSockets, flushes the doc,
# waits up to SHUTDOWN_TIMEOUT_SEC for in-flight uploads, closes SQLite, exits 0.
STOPSIGNAL SIGTERM
CMD ["node", "server.js"]
