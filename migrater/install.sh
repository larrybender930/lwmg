#!/usr/bin/env bash
#
# One-shot installer for a Lugawatch migrater server.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/larrybender930/lwmg/main/migrater/install.sh)
#
# Takes no arguments and no environment. Everything the worker needs is in
# config.js, so this just installs Node, git and pm2 if missing, clones the repo,
# starts the worker and registers it to survive a reboot.
#
# Safe to re-run: it updates the code and restarts in place. Staged downloads and
# this server's identity in work/ are left untouched, so a re-run never loses an
# in-flight transfer.

set -euo pipefail

REPO="https://github.com/larrybender930/lwmg.git"
BRANCH="main"
INSTALL_DIR="${HOME:-/root}/lwmg"
APP_NAME="migrater"

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31mError:\033[0m %s\n\n' "$1" >&2; exit 1; }

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

# ── Dependencies ─────────────────────────────────────────────────────────────
say "Installing dependencies"

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq curl ca-certificates git
elif command -v dnf >/dev/null 2>&1; then
  $SUDO dnf install -y -q curl ca-certificates git
elif command -v yum >/dev/null 2>&1; then
  $SUDO yum install -y -q curl ca-certificates git
else
  die "No supported package manager found (apt-get, dnf or yum)."
fi

# Node 20 LTS. Distro packages are usually far too old for this codebase.
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
fi

if [ "$NODE_MAJOR" -lt 18 ]; then
  say "Installing Node.js 20"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
    $SUDO apt-get install -y -qq nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO -E bash -
    $SUDO "$(command -v dnf || command -v yum)" install -y -q nodejs
  fi
else
  say "Node.js $(node -v) is already current enough"
fi

command -v pm2 >/dev/null 2>&1 || { say "Installing pm2"; $SUDO npm install -g pm2 --silent; }

# ── Code ─────────────────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard --quiet "origin/$BRANCH"
else
  say "Cloning $REPO"
  rm -rf "$INSTALL_DIR"
  git clone --quiet --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR/migrater" || die "No migrater/ folder in $INSTALL_DIR"

say "Installing npm packages"
npm install --omit=dev --silent --no-audit --no-fund

# ── Run ──────────────────────────────────────────────────────────────────────
say "Starting $APP_NAME"
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start ecosystem.config.js
pm2 save

# The worker is already running and saved by this point, so a distro without
# systemd should warn rather than abort and look like a failed install.
say "Registering pm2 to start on boot"
RUN_USER="${USER:-$(id -un)}"
RUN_HOME="${HOME:-$(getent passwd "$RUN_USER" | cut -d: -f6)}"
if $SUDO env PATH="$PATH:$(dirname "$(command -v node)")" \
     pm2 startup systemd -u "$RUN_USER" --hp "$RUN_HOME" >/dev/null 2>&1; then
  pm2 save
else
  printf '\033[1;33m  Warning:\033[0m could not register pm2 for boot automatically.\n'
  printf '           Run `pm2 startup` yourself and follow what it prints.\n'
fi

FREE_GB=$(df -BG --output=avail . 2>/dev/null | tail -1 | tr -dc '0-9' || echo '?')
BUDGET_GB=$(node -p 'require("./config").MAX_DISK_BYTES / 1024**3' 2>/dev/null || echo '?')

cat <<EOF

  ✅ migrater is running.

     directory   $(pwd)
     identity    generated on first boot into work/worker-id
     disk budget ${BUDGET_GB} GB staged   (free on this volume: ${FREE_GB} GB)

     pm2 logs ${APP_NAME}      watch it work
     pm2 status                is it alive
     pm2 stop ${APP_NAME}      pause — in-flight items resume on restart

  Fleet progress is at /king/migration on the admin dashboard.

EOF

if [ "$FREE_GB" != '?' ] && [ "$BUDGET_GB" != '?' ] && [ "$FREE_GB" -lt "$BUDGET_GB" ] 2>/dev/null; then
  printf '\033[1;33m  Warning:\033[0m only %s GB free but the disk budget is %s GB.\n' "$FREE_GB" "$BUDGET_GB"
  printf '           Lower MAX_DISK_BYTES in config.js to fit this volume.\n\n'
fi
