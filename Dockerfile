# syntax=docker/dockerfile:1.7

# Portal runs TypeScript directly under Bun (no compile step), so this is a
# single-stage image. We deliberately COPY in a pre-installed node_modules
# rather than running an installer in the build container, because:
#
#   * Bun's installer has known issues honouring HTTP(S)_PROXY in some setups.
#   * npm inside a build container can't reach a proxy bound to the host's
#     localhost without extra Docker networking gymnastics.
#
# Running the install on the host once (it caches in node_modules) keeps the
# build deterministic, fast, and proxy-friendly. archiver and friends are
# pure JS so it doesn't matter which platform installed them.
#
# Build recipe:
#   npm install --omit=dev --no-audit --no-fund   # one-time, on the host
#   docker build -t portal .

FROM oven/bun:1-alpine
WORKDIR /app

COPY package.json ./
COPY node_modules ./node_modules
COPY src ./src
COPY public ./public
COPY config.json ./config.json

# Container-friendly defaults. Override via `-e` / compose `environment:`.
ENV PORTAL_CONFIG=/app/config.json \
    PORTAL_ROOT=/data \
    PORTAL_HOST=0.0.0.0 \
    PORTAL_PORT=4000

# /data is the conventional mount point for the file root.
RUN mkdir -p /data && chown -R bun:bun /app /data

USER bun
EXPOSE 4000
VOLUME ["/data"]

# Liveness probe — same endpoint the client uses to show the connected dot.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORTAL_PORT}/api/ping" >/dev/null || exit 1

CMD ["bun", "run", "src/server.ts"]


