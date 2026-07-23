#!/bin/sh
# Updates a self-hosted Quorum to the latest published images.
#
# Pulls the newest api and web images, then recreates the containers. Database
# migrations run automatically when the new API version starts, so there is no
# separate migrate step. Your data lives in the `db_data` and `uploads` volumes
# and is untouched.
set -eu

cd "$(dirname "$0")"

echo "Pulling the latest Quorum images..."
docker compose pull

echo "Restarting with the new version..."
docker compose up -d

echo "Removing old images..."
docker image prune -f >/dev/null 2>&1 || true

echo "Done. Migrations run on start; check progress with: docker compose logs -f api"
