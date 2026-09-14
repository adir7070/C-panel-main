#!/usr/bin/env bash
# Atomic release deploy for iconiq-server.
# Runs on the self-hosted GitHub Actions runner (prod or staging EC2).
#
# Layout managed by this script:
#   /var/www/iconiq-backend           -> symlink to /var/www/iconiq-releases/<current>
#   /var/www/iconiq-releases/<sha>-<ts>/   built release
#   /var/www/iconiq-shared/.env       real env file, symlinked into each release
#   /var/www/iconiq-shared/node_modules  warm cache reused across releases
#
# Usage: release.sh <prod|stg>
# Required env: GITHUB_SHA, GH_TOKEN
set -euo pipefail

ENV_NAME="${1:-prod}"
APP_LINK="/var/www/iconiq-backend"
RELEASES_DIR="/var/www/iconiq-releases"
SHARED_DIR="/var/www/iconiq-shared"
REPO_URL="https://x-access-token:${GH_TOKEN}@github.com/IconiqMotion/iconiq-server.git"
HEALTH_URL="http://localhost:3900/api/health"
PM2_APP="iconiq-server"
KEEP_RELEASES=3

if [[ -z "${GITHUB_SHA:-}" ]]; then
  echo "ERROR: GITHUB_SHA env var is required" >&2
  exit 1
fi
if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "ERROR: GH_TOKEN env var is required" >&2
  exit 1
fi

SHORT_SHA="${GITHUB_SHA:0:7}"
TS="$(date +%Y%m%d-%H%M%S)"
RELEASE_DIR="${RELEASES_DIR}/${SHORT_SHA}-${TS}"

echo "=== iconiq-server deploy (${ENV_NAME}) ==="
echo "  target sha:   ${GITHUB_SHA}"
echo "  release dir:  ${RELEASE_DIR}"
echo "  current link: $(readlink -f "${APP_LINK}" 2>/dev/null || echo '(none)')"

# Remember current release so we can roll back on failure
PREV_DIR=""
if [[ -L "${APP_LINK}" ]]; then
  PREV_DIR="$(readlink -f "${APP_LINK}")"
fi

# --- 1. Copy source into isolated release directory --------------------------
mkdir -p "${RELEASES_DIR}"

echo "--> fetching source"
if [[ -n "${GITHUB_WORKSPACE:-}" && -d "${GITHUB_WORKSPACE}" ]]; then
  # Running inside GitHub Actions — workspace already checked out, just copy it.
  rsync -a --exclude='.git' "${GITHUB_WORKSPACE}/" "${RELEASE_DIR}/"
else
  # Fallback: direct git clone (requires GH_TOKEN with repo scope).
  git clone --depth=50 "${REPO_URL}" "${RELEASE_DIR}"
  cd "${RELEASE_DIR}"
  git fetch --depth=50 origin "${GITHUB_SHA}"
  git checkout --detach "${GITHUB_SHA}"
  git remote set-url origin "https://github.com/IconiqMotion/iconiq-server.git"
fi
cd "${RELEASE_DIR}"

# --- 2. Wire up shared secrets + warm node_modules ---------------------------
echo "--> linking shared env"
if [[ ! -f "${SHARED_DIR}/.env" ]]; then
  echo "ERROR: ${SHARED_DIR}/.env missing. Create it before first deploy." >&2
  exit 1
fi
# The repo tracks a .env (historical mistake — it's in .gitignore AND committed),
# so `git checkout` lands a stale real file on top of the release.
# Force-remove then symlink so the app always reads the shared secrets file.
rm -f "${RELEASE_DIR}/.env"
ln -s "${SHARED_DIR}/.env" "${RELEASE_DIR}/.env"
# Verify it actually became a symlink (fail loud if not)
if [[ ! -L "${RELEASE_DIR}/.env" ]]; then
  echo "ERROR: ${RELEASE_DIR}/.env is not a symlink — shared env wiring failed" >&2
  exit 1
fi

if [[ -d "${SHARED_DIR}/node_modules" ]]; then
  echo "--> warming node_modules from cache"
  cp -rT "${SHARED_DIR}/node_modules" "${RELEASE_DIR}/node_modules"
fi

# --- 2b. Shared pdf/pages — uploaded contract docs must survive deployments ---
# On first ever deploy: seed shared dir from the repo's baseline files.
# On subsequent deploys: repo files are ignored; the live uploaded versions win.
if [[ ! -d "${SHARED_DIR}/pdf/pages" ]]; then
  echo "--> bootstrapping shared pdf/pages from repo baseline"
  mkdir -p "${SHARED_DIR}/pdf"
  cp -r "${RELEASE_DIR}/pdf/pages" "${SHARED_DIR}/pdf/pages"
fi
# Replace the freshly-checked-out pdf/pages with a symlink to shared storage.
rm -rf "${RELEASE_DIR}/pdf/pages"
ln -s "${SHARED_DIR}/pdf/pages" "${RELEASE_DIR}/pdf/pages"
echo "--> pdf/pages → ${SHARED_DIR}/pdf/pages (symlinked)"

# --- 3. Install deps + sanity check -----------------------------------------
echo "--> npm ci"
# Keep npm's heap modest so npm ci doesn't OOM on small instances.
NODE_OPTIONS="--max-old-space-size=768" npm ci --omit=dev --no-audit --no-fund

echo "--> node --check server.js"
node --check server.js

# --- 3b. Build frontend apps (webApp + whoAppAi) ----------------------------
echo "--> npm run build (React frontends)"
npm run build

# Refresh shared cache from this release for faster next deploy (best effort)
rsync -a --delete "${RELEASE_DIR}/node_modules/" "${SHARED_DIR}/node_modules/" 2>/dev/null || true

# --- 4. Atomic flip ---------------------------------------------------------
echo "--> flipping symlink to ${RELEASE_DIR}"
ln -sfn "${RELEASE_DIR}" "${APP_LINK}"

# --- 5. Restart pm2 ---------------------------------------------------------
echo "--> (re)starting pm2 app ${PM2_APP}"
# Delete then start so pm2 re-resolves the symlinked cwd to the new release
pm2 delete "${PM2_APP}" 2>/dev/null || true
cd "${APP_LINK}"
pm2 start ecosystem.config.js --only "${PM2_APP}" --env production
pm2 save

# --- 6. Health check --------------------------------------------------------
# Boot is slow (~65s) because server.listen runs after DB connect, index setup,
# Drive OAuth, and WA worker init. Give it up to 3 minutes before giving up.
echo "--> health check"
HEALTHY=0
for i in $(seq 1 36); do
  sleep 5
  if curl -sf "${HEALTH_URL}" >/dev/null; then
    echo "    healthy (attempt ${i})"
    HEALTHY=1
    break
  fi
  echo "    attempt ${i}/36 not ready"
done

if [[ "${HEALTHY}" -ne 1 ]]; then
  echo "!! health check failed — rolling back"
  if [[ -n "${PREV_DIR}" && -d "${PREV_DIR}" ]]; then
    ln -sfn "${PREV_DIR}" "${APP_LINK}"
    pm2 delete "${PM2_APP}" 2>/dev/null || true
    cd "${APP_LINK}"
    pm2 start ecosystem.config.js --only "${PM2_APP}" --env production
    pm2 save
    echo "   rolled back to ${PREV_DIR}"
  else
    echo "   no previous release to roll back to"
  fi
  pm2 logs "${PM2_APP}" --lines 30 --nostream || true
  exit 1
fi

# --- 7. Prune old releases --------------------------------------------------
echo "--> pruning releases (keeping latest ${KEEP_RELEASES})"
# Keep the currently-linked release + the most recent ${KEEP_RELEASES} by mtime.
CURRENT="$(readlink -f "${APP_LINK}")"
ls -1dt "${RELEASES_DIR}"/*/ 2>/dev/null | tail -n +"$((KEEP_RELEASES + 1))" | while read -r d; do
  d="${d%/}"
  if [[ "${d}" != "${CURRENT}" ]]; then
    echo "    rm -rf ${d}"
    rm -rf "${d}"
  fi
done

echo "=== deployed ${SHORT_SHA} ==="
