FROM node:22-alpine

WORKDIR /app

# Dependencies are installed in their own layer so source edits do not trigger
# a reinstall on every rebuild.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

# A named volume mounts here; creating it owned by node in the image means the
# fresh volume inherits that ownership, so the non-root process can write to it.
RUN mkdir -p /data/uploads && chown -R node:node /data

ENV NODE_ENV=production
USER node
EXPOSE 3000

CMD ["node", "src/index.js"]
