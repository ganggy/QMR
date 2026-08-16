#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE="${1:-unknown}"
OLD_ROOT='/opt/qrm'
NEW_ROOT='/opt/qmr'
ARCHIVE='/tmp/qmr-kss-deploy.tar.gz'
CONFIG='/tmp/qmr-kss.env'

cleanup() {
  rm -f "$ARCHIVE" "$CONFIG" /tmp/qmr-old-pm2-apps.txt /tmp/qmr-pm2.json /tmp/qmr-remote-install.sh
}
trap cleanup EXIT

if [[ "$OLD_ROOT" != '/opt/qrm' || "$NEW_ROOT" != '/opt/qmr' ]]; then
  echo 'ERROR: deployment path safety check failed.' >&2
  exit 25
fi
if [[ ! -f "$ARCHIVE" ]]; then
  echo 'ERROR: deployment archive is missing.' >&2
  exit 26
fi

echo '[1/7] Requesting permission for /opt...'
sudo -v

echo '[2/7] Stopping applications from retired /opt/qrm...'
if command -v pm2 >/dev/null 2>&1; then
  pm2 jlist > /tmp/qmr-pm2.json
  node - /tmp/qmr-pm2.json <<'NODE' > /tmp/qmr-old-pm2-apps.txt
const fs = require('node:fs');
const apps = JSON.parse(fs.readFileSync(process.argv[2], 'utf8') || '[]');
for (const app of apps) {
  const env = app.pm2_env || {};
  if ((env.pm_cwd || '').startsWith('/opt/qrm') || (env.pm_exec_path || '').startsWith('/opt/qrm')) {
    console.log(app.name);
  }
}
NODE
  while IFS= read -r app_name; do
    [[ -z "$app_name" ]] && continue
    echo "Stopping PM2 app: $app_name"
    pm2 delete "$app_name" || true
  done < /tmp/qmr-old-pm2-apps.txt
fi

for cwd_link in /proc/[0-9]*/cwd; do
  process_cwd="$(readlink "$cwd_link" 2>/dev/null || true)"
  case "$process_cwd" in
    /opt/qrm|/opt/qrm/*)
      process_pid="$(cut -d/ -f3 <<< "$cwd_link")"
      echo "Stopping PID $process_pid from $process_cwd"
      sudo kill "$process_pid" 2>/dev/null || true
      ;;
  esac
done
sleep 1

echo '[3/7] Removing /opt/qrm and preparing /opt/qmr...'
sudo rm -rf -- "$OLD_ROOT"
sudo mkdir -p "$NEW_ROOT/data/uploads" "$NEW_ROOT/logs"
sudo chown -R "$(id -un):$(id -gn)" "$NEW_ROOT"

echo '[4/7] Extracting application...'
tar -xzf "$ARCHIVE" -C "$NEW_ROOT"
if [[ -f "$CONFIG" ]]; then
  mv "$CONFIG" "$NEW_ROOT/.env"
fi
cd "$NEW_ROOT"
if [[ ! -f .env ]]; then
  echo 'ERROR: /opt/qmr/.env is missing. Run deployment with -Configure.' >&2
  exit 23
fi
chmod 600 .env

echo '[5/7] Installing Node.js dependencies...'
node_major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
if [[ "$node_major" -lt 22 ]]; then
  echo "ERROR: Node.js 22 or newer is required. Current: $(node --version 2>/dev/null || echo missing)" >&2
  exit 22
fi
npm ci --omit=dev
printf '%s\n' "$RELEASE" > "$NEW_ROOT/.release"

echo '[6/7] Checking TCP port 3509...'
if pm2 describe qmr-kss >/dev/null 2>&1; then
  pm2 stop qmr-kss
  sleep 1
fi
if command -v ss >/dev/null 2>&1 && ss -ltn | grep -q ':3509 '; then
  echo 'ERROR: TCP port 3509 is still used by another process.' >&2
  ss -ltnp | grep ':3509 ' || true
  exit 24
fi

echo '[7/7] Starting qmr-kss with PM2...'
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
pm2 status qmr-kss
echo "QMR_DEPLOY_OK:$RELEASE"
