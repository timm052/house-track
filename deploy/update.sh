#!/bin/bash
# Install or update House Track from GitHub (a private repo): fetch the stack files, sign in to GitHub's container
# registry, pull the images for the version asked for, and restart. Run it from the stack folder:
#
#   ./update.sh 0.3.0        # that version
#   ./update.sh              # the version already in .env
#
# Needs a GitHub token (classic, scopes: repo, read:packages) in .github-token next to this script. Unraid's
# /root is wiped on reboot, so the token lives here and the registry sign-in is repeated each run.
set -euo pipefail
cd "$(dirname "$0")"

REPO=timm052/house-track
TOKEN_FILE=.github-token
[ -s "$TOKEN_FILE" ] || { echo "Put a GitHub token (scopes: repo, read:packages) in $PWD/$TOKEN_FILE first."; exit 1; }
TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE")

fetch() {  # a file from the repo at the given ref
  mkdir -p "$(dirname "$2")"
  curl -fsSL -H "Authorization: token $TOKEN" "https://raw.githubusercontent.com/$REPO/$1/$2" -o "$2.new" && mv "$2.new" "$2"
}

VERSION=${1:-$(sed -n 's/^VERSION=//p' .env 2>/dev/null || true)}
[ -n "$VERSION" ] || { echo "Which version? e.g. ./update.sh 0.3.0"; exit 1; }
REF="v$VERSION"

echo "Fetching the stack files for $REF…"
for f in compose.yaml deploy/serve.json deploy/update.sh deploy/INSTALL.md .env.example; do fetch "$REF" "$f"; done
cp deploy/update.sh update.sh.new && chmod +x update.sh.new && mv update.sh.new update.sh

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from the example. Fill it in (see INSTALL.md), then run ./update.sh $VERSION again."
  exit 0
fi
# The version and image owner this stack runs.
grep -q '^VERSION=' .env && sed -i "s/^VERSION=.*/VERSION=$VERSION/" .env || echo "VERSION=$VERSION" >> .env
grep -q '^IMAGE_OWNER=' .env || echo "IMAGE_OWNER=${REPO%%/*}" >> .env

echo "$TOKEN" | docker login ghcr.io -u "${REPO%%/*}" --password-stdin > /dev/null
if docker compose ps --status running --services 2>/dev/null | grep -qx api; then
  echo "Backing up before the update…"
  docker compose --profile ops run --rm backup
fi
docker compose --profile setup pull api web setup
docker compose up -d --no-build
echo "House Track $VERSION is running. Check any release notes in deploy/INSTALL.md for extra steps."
