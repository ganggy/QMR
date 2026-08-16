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
  # Remove the known retired process names first. This also works when an old
  # PM2 release prints a warning before its JSON output.
  pm2 delete qmr-api >/dev/null 2>&1 || true
  pm2 delete qrm >/dev/null 2>&1 || true
  pm2 jlist > /tmp/qmr-pm2.json
  node - /tmp/qmr-pm2.json <<'NODE' > /tmp/qmr-old-pm2-apps.txt
const fs = require('node:fs');
const raw = fs.readFileSync(process.argv[2], 'utf8');
const objectArray = raw.indexOf('[{');
const emptyArray = raw.indexOf('[]');
const start = objectArray >= 0 ? objectArray : emptyArray;
const end = raw.lastIndexOf(']');
if (start < 0 || end < start) process.exit(0);
const apps = JSON.parse(raw.slice(start, end + 1));
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
NODE_VERSION='v22.20.0'
case "$(uname -m)" in
  x86_64)
    NODE_ARCH='x64'
    NODE_SHA256='00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc'
    ;;
  aarch64|arm64)
    NODE_ARCH='arm64'
    NODE_SHA256='06907b9c088ce62305bc1530e5c1ae1510245114645768f7750c349c5b6fe667'
    ;;
  *) echo "ERROR: Unsupported CPU architecture: $(uname -m)" >&2; exit 22 ;;
esac
NODE_PACKAGE="node-${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_RUNTIME="$NEW_ROOT/runtime/$NODE_PACKAGE"
if [[ ! -x "$NODE_RUNTIME/bin/node" ]]; then
  echo "Installing isolated Node.js $NODE_VERSION runtime..."
  mkdir -p "$NEW_ROOT/runtime"
  NODE_ARCHIVE="/tmp/${NODE_PACKAGE}.tar.xz"
  if command -v curl >/dev/null 2>&1; then
    curl -fL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_PACKAGE}.tar.xz" -o "$NODE_ARCHIVE"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$NODE_ARCHIVE" "https://nodejs.org/dist/${NODE_VERSION}/${NODE_PACKAGE}.tar.xz"
  else
    echo 'ERROR: curl or wget is required to install Node.js 22.' >&2
    exit 22
  fi
  echo "$NODE_SHA256  $NODE_ARCHIVE" | sha256sum --check --status || {
    echo 'ERROR: Node.js runtime checksum verification failed.' >&2
    exit 22
  }
  tar -xJf "$NODE_ARCHIVE" -C "$NEW_ROOT/runtime"
  rm -f "$NODE_ARCHIVE"
fi
ln -sfn "$NODE_RUNTIME" "$NEW_ROOT/runtime/node"
export PATH="$NEW_ROOT/runtime/node/bin:$PATH"
echo "Application runtime: $(node --version)"
npm ci --omit=dev
printf '%s\n' "$RELEASE" > "$NEW_ROOT/.release"

echo '[6/7] Checking TCP port 3509...'
if pm2 describe qmr-kss >/dev/null 2>&1; then
  pm2 stop qmr-kss
  sleep 1
fi

port_3509_is_busy() {
  ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:)3509$'
}

stop_port_3509() {
  local signal="$1"
  if command -v fuser >/dev/null 2>&1; then
    sudo fuser --kill "-$signal" 3509/tcp >/dev/null 2>&1 || true
  elif command -v lsof >/dev/null 2>&1; then
    sudo lsof -t -iTCP:3509 -sTCP:LISTEN 2>/dev/null | xargs -r sudo kill "-$signal" || true
  else
    echo 'ERROR: fuser or lsof is required to replace the existing service on port 3509.' >&2
    exit 24
  fi
}

if port_3509_is_busy; then
  echo 'Stopping the retired service currently using TCP port 3509...'
  stop_port_3509 TERM
  sleep 2
fi
if port_3509_is_busy; then
  echo 'The retired service did not stop; terminating it now...'
  stop_port_3509 KILL
  sleep 1
fi
if port_3509_is_busy; then
  echo 'ERROR: TCP port 3509 is still used after termination attempts.' >&2
  sudo ss -ltnp | grep ':3509 ' || true
  exit 24
fi

echo '[7/7] Starting qmr-kss with PM2...'
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
pm2 status qmr-kss
echo "QMR_DEPLOY_OK:$RELEASE"
