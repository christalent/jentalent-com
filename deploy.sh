#!/usr/bin/env bash
# Deploy the jentalent.com site to NFSHost.
#
# The origin sits behind an edge cache (via: e7s) that serves static
# assets by URL and will happily hand back a stale stylesheet after a
# deploy. The fix is a version query on every asset reference, bumped
# on each deploy so the cache key changes.
#
# The NFSHost account does not allow .htaccess (mod_headers is absent),
# so the version query is the only available lever.
#
# Usage: ./deploy.sh
set -euo pipefail

cd "$(dirname "$0")"

REMOTE="${REMOTE:-nfs-jentalent}"
DOCROOT="${DOCROOT:-/home/public/}"
# Bump this to invalidate every cached asset.
VERSION="v=$(date -u +%Y%m%d-%H%M%S)"

echo "==> asset version: $VERSION"

# Rewrite the version on every asset reference in the HTML.
for f in index.html log.html resume.html services.html; do
    sed -i -E "s/(style\.css|main\.js|log\.js)\?v=[0-9A-Za-z._-]+/\1?${VERSION}/g" "$f"
done

echo "==> checking syntax"
node --check log.js
node --check main.js
php -l api.php > /dev/null

echo "==> syncing to ${REMOTE}:${DOCROOT}"
rsync -avz \
    --exclude='.git' \
    --exclude='tests/' \
    --exclude='.htaccess' \
    --exclude='deploy.sh' \
    ./ "${REMOTE}:${DOCROOT}"

echo "==> done. Verify with:"
echo "    curl -sI https://www.jentalent.com/log.html | grep -i cache"
