FROM node:22-alpine

WORKDIR /app

# Dependencies are installed in their own layer so source edits do not trigger
# a reinstall on every rebuild.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

# One-off maintenance scripts, run against a live deployment.
COPY scripts ./scripts

# A named volume mounts here; creating it owned by node in the image means the
# fresh volume inherits that ownership, so the non-root process can write to it.
RUN mkdir -p /data/uploads && chown -R node:node /data

# Build provenance, stamped in by CI (.github/workflows/release.yml). GIT_SHA
# lets the running app report the exact commit it was built from (shown in the
# footer); the labels let `docker inspect` and provenance tooling trace the
# image back to its source. A local build without these args reports "unknown".
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ARG VERSION=unknown
LABEL org.opencontainers.image.source="https://github.com/thomasloupe/Quorum" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.version="$VERSION"

ENV NODE_ENV=production \
    QUORUM_GIT_SHA=$GIT_SHA \
    QUORUM_BUILD_TIME=$BUILD_TIME
USER node
EXPOSE 3000

CMD ["node", "src/index.js"]
