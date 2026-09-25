#!/bin/bash
# Install or update House Track from GitHub's container registry: back up, pull the images for the version asked
# for, restart, and run any steps the new version needs (deploy/after-update.sh). The stack's own files (this
# script, docker-compose.yml, .env.example, deploy/) come out of the setup image, so the server needs no access to
# the code. The stack is the compose project "housetrack" (the name in the compose file), the same one Unraid's
# Compose Manager runs when its stack is called housetrack. Run it from the stack folder:
#
#   ./update.sh latest       # the newest published version; does nothing if already on it (the nightly job)
#   ./update.sh 0.3.2        # that version
#   ./update.sh              # the version already in .env
#
# Needs a GitHub token (classic, scope read:packages only) in .github-token next to this script. Unraid's /root
# is wiped on reboot, so the token lives here and the registry sign-in is repeated each run. On Unraid, updates
# and failures show up as notifications.
set -euo pipefail
cd "$(dirname "$0")"

OWNER=timm052
REGISTRY=ghcr.io/$OWNER
TOKEN_FILE=.github-token
NOTIFY=/usr/local/emhttp/webGui/scripts/notify   # Unraid's notifications, when there

notify() {  # importance (normal|warning|alert), subject, description
  if [ -x "$NOTIFY" ]; then "$NOTIFY" -e "House Track" -i "$1" -s "$2" -d "$3" > /dev/null 2>&1 || true; fi
}
trap 'notify alert "House Track update failed" "update.sh stopped at line $LINENO. See the log in $PWD."' ERR

[ -s "$TOKEN_FILE" ] || { echo "Put a GitHub token (classic, scope read:packages) in $PWD/$TOKEN_FILE first."; exit 1; }
TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE")
echo "$TOKEN" | docker login ghcr.io -u "$OWNER" --password-stdin > /dev/null

published() {  # are all three of this version's images in the registry? (a tag whose build failed has none)
  for image in api web setup; do
    docker manifest inspect "$REGISTRY/housetrack-$image:$1" > /dev/null 2>&1 || return 1
  done
}

versions() {  # every version tag of the api image, newest first
  local bearer
  bearer=$(curl -fsSL -u "$OWNER:$TOKEN" "https://ghcr.io/token?service=ghcr.io&scope=repository:$OWNER/housetrack-api:pull" \
           | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  curl -fsSL -H "Authorization: Bearer $bearer" "https://ghcr.io/v2/$OWNER/housetrack-api/tags/list?n=1000" \
    | grep -o '"[0-9]*\.[0-9]*\.[0-9]*"' | tr -d '"' | sort -rV
}

CURRENT=$(sed -n 's/^VERSION=//p' .env 2>/dev/null || true)
VERSION=${1:-$CURRENT}
if [ "$VERSION" = latest ]; then
  VERSION=""
  for v in $(versions); do
    if published "$v"; then VERSION=$v; break; fi
  done
  [ -n "$VERSION" ] || { echo "No published version found."; exit 1; }
  if [ "$VERSION" = "$CURRENT" ]; then
    echo "$(date '+%F %T') Up to date ($CURRENT)."
    exit 0
  fi
  # Never go backwards (e.g. a newer version installed by hand whose images were later removed).
  if [ -n "$CURRENT" ] && [ "$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | tail -1)" = "$CURRENT" ]; then
    echo "$(date '+%F %T') $CURRENT is newer than the latest published ($VERSION); leaving it."
    exit 0
  fi
fi
[ -n "$VERSION" ] || { echo "Which version? e.g. ./update.sh latest or ./update.sh 0.3.2"; exit 1; }

echo "$(date '+%F %T') Updating to $VERSION (from ${CURRENT:-nothing})…"
SETUP_IMAGE=$REGISTRY/housetrack-setup:$VERSION
docker pull -q "$SETUP_IMAGE" > /dev/null
rm -f deploy/after-update.sh   # only the new version's steps
docker run --rm --entrypoint tar "$SETUP_IMAGE" -C /stack -cf - . | tar -xf -
# From 0.3.3 the stack's compose file is docker-compose.yml (for Unraid's Compose Manager); drop the old name.
[ -f docker-compose.yml ] && rm -f compose.yaml
cp deploy/update.sh update.sh.new && chmod +x update.sh.new && mv update.sh.new update.sh

FIRST_RUN=false
[ -f .env ] || { cp .env.example .env; FIRST_RUN=true; }
# The version and image owner this stack runs.
grep -q '^VERSION=' .env && sed -i "s/^VERSION=.*/VERSION=$VERSION/" .env || echo "VERSION=$VERSION" >> .env
grep -q '^IMAGE_OWNER=' .env || echo "IMAGE_OWNER=$OWNER" >> .env
if [ "$FIRST_RUN" = true ]; then
  echo "Fetched House Track $VERSION and created .env. Fill in .env (in Compose Manager: Edit Stack > Env File), then Compose Up."
  exit 0
fi

if docker compose ps --status running --services 2>/dev/null | grep -qx api; then
  echo "Backing up before the update…"
  docker compose --profile ops run --rm backup
fi
docker compose --profile setup pull api web setup
docker compose up -d --no-build
if [ -f deploy/after-update.sh ]; then bash deploy/after-update.sh "${CURRENT:-}" "$VERSION"; fi

echo "$(date '+%F %T') House Track $VERSION is running."
[ "$VERSION" = "$CURRENT" ] || notify normal "House Track updated to $VERSION" "Was ${CURRENT:-not installed}. Backed up first."
