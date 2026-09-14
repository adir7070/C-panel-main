#!/usr/bin/env bash
# ONE-TIME migration: convert /var/www/iconiq-backend from a live git checkout
# into a symlink pointing at /var/www/iconiq-releases/<bootstrap>/.
#
# Run this ONCE on prod (and separately ONCE on staging) AFTER the PR with
# ecosystem.config.js + release.sh has been merged into the branch that's
# currently deployed on the server.
#
# Prerequisites (check before running):
#   - You are ubuntu@the-target-ec2
#   - /var/www/iconiq-backend is currently a regular directory with .git
#   - pm2 currently manages the iconiq-server process
#   - /var/www/iconiq-backend/ecosystem.config.js exists (i.e., the new code is
#     already checked out — run `git pull` in there first if not)
#
# What it does:
#   1. Pulls latest code into the live dir so bootstrap contains the new files
#   2. Creates /var/www/iconiq-releases and /var/www/iconiq-shared
#   3. Moves the live dir into /var/www/iconiq-releases/bootstrap-<timestamp>/
#   4. Moves .env into /var/www/iconiq-shared/.env and symlinks it back
#   5. Seeds /var/www/iconiq-shared/node_modules from the current release
#   6. Makes /var/www/iconiq-backend a symlink to the bootstrap release
#   7. Restarts pm2 using the new ecosystem.config.js
#
# If anything goes wrong, the script aborts before destructive steps. Read
# the output carefully.
set -euo pipefail

APP_LINK="/var/www/iconiq-backend"
RELEASES_DIR="/var/www/iconiq-releases"
SHARED_DIR="/var/www/iconiq-shared"
PM2_APP="iconiq-server"

echo "=== one-time migration to release-folder layout ==="

if [[ "$(whoami)" != "ubuntu" ]]; then
  echo "ERROR: must run as ubuntu (current: $(whoami))" >&2
  exit 1
fi

if [[ ! -d "${APP_LINK}" ]]; then
  echo "ERROR: ${APP_LINK} does not exist" >&2
  exit 1
fi

if [[ -L "${APP_LINK}" ]]; then
  echo "ERROR: ${APP_LINK} is already a symlink — migration has already been done." >&2
  readlink -f "${APP_LINK}"
  exit 1
fi

if [[ ! -d "${APP_LINK}/.git" ]]; then
  echo "ERROR: ${APP_LINK}/.git missing — expected a live git checkout" >&2
  exit 1
fi

if [[ ! -f "${APP_LINK}/ecosystem.config.js" ]]; then
  echo "ERROR: ${APP_LINK}/ecosystem.config.js missing." >&2
  echo "Run 'cd ${APP_LINK} && git pull' first so the bootstrap release has the new files." >&2
  exit 1
fi

if [[ ! -f "${APP_LINK}/.env" ]]; then
  echo "ERROR: ${APP_LINK}/.env missing." >&2
  exit 1
fi

# Confirm pm2 app is known
if ! pm2 describe "${PM2_APP}" >/dev/null 2>&1; then
  echo "WARN: pm2 does not currently know about '${PM2_APP}'. The script will start it fresh at the end."
fi

TS="$(date +%Y%m%d-%H%M%S)"
BOOTSTRAP="${RELEASES_DIR}/bootstrap-${TS}"

echo "Plan:"
echo "  - create ${RELEASES_DIR}  and ${SHARED_DIR}"
echo "  - mv ${APP_LINK} -> ${BOOTSTRAP}"
echo "  - mv ${BOOTSTRAP}/.env -> ${SHARED_DIR}/.env (+ symlink back)"
echo "  - copy ${BOOTSTRAP}/node_modules -> ${SHARED_DIR}/node_modules (cache)"
echo "  - ln -s ${BOOTSTRAP} ${APP_LINK}"
echo "  - pm2 delete ${PM2_APP}; pm2 start ecosystem.config.js --env production; pm2 save"
read -r -p "Proceed? [y/N] " REPLY
if [[ "${REPLY:-N}" != "y" && "${REPLY:-N}" != "Y" ]]; then
  echo "aborted"
  exit 1
fi

echo "--> creating ${RELEASES_DIR} and ${SHARED_DIR}"
sudo mkdir -p "${RELEASES_DIR}" "${SHARED_DIR}"
sudo chown ubuntu:ubuntu "${RELEASES_DIR}" "${SHARED_DIR}"

# Grant ubuntu ownership of /var/www so future deploys can update the
# /var/www/iconiq-backend symlink without sudo. Required by release.sh.
echo "--> granting ubuntu ownership of /var/www"
sudo chown ubuntu:ubuntu /var/www

echo "--> moving live dir to ${BOOTSTRAP}"
sudo mv "${APP_LINK}" "${BOOTSTRAP}"
sudo chown -h ubuntu:ubuntu "${BOOTSTRAP}"

echo "--> moving .env into shared/"
mv "${BOOTSTRAP}/.env" "${SHARED_DIR}/.env"
ln -sfn "${SHARED_DIR}/.env" "${BOOTSTRAP}/.env"

if [[ -d "${BOOTSTRAP}/node_modules" ]]; then
  echo "--> seeding shared node_modules cache"
  cp -rT "${BOOTSTRAP}/node_modules" "${SHARED_DIR}/node_modules"
fi

echo "--> creating symlink ${APP_LINK} -> ${BOOTSTRAP}"
sudo ln -sfn "${BOOTSTRAP}" "${APP_LINK}"
sudo chown -h ubuntu:ubuntu "${APP_LINK}"

echo "--> restarting pm2 to pick up new path"
pm2 delete "${PM2_APP}" 2>/dev/null || true
cd "${APP_LINK}"
pm2 start ecosystem.config.js --only "${PM2_APP}" --env production
pm2 save

echo "--> waiting for health check"
for i in $(seq 1 12); do
  sleep 5
  if curl -sf "http://localhost:3900/api/health" >/dev/null; then
    echo "    healthy (attempt ${i})"
    echo "=== migration complete ==="
    pm2 list
    ls -la "${APP_LINK}" "${RELEASES_DIR}" "${SHARED_DIR}"
    exit 0
  fi
  echo "    attempt ${i}/12 not ready"
done

echo "!! health check failed after migration. Investigate with:"
echo "   pm2 logs ${PM2_APP} --lines 50 --nostream"
echo "   readlink -f ${APP_LINK}"
exit 1
