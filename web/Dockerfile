FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine

# Build provenance, stamped in by CI (.github/workflows/release.yml). The web
# image serves static files, so the commit is surfaced in the footer via the
# API's /api/version; these labels let provenance tooling trace this image too.
ARG GIT_SHA=unknown
ARG VERSION=unknown
LABEL org.opencontainers.image.source="https://github.com/thomasloupe/Quorum" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.version="$VERSION"

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
