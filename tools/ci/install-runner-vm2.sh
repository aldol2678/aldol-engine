#!/bin/sh
# Install the GitHub Actions self-hosted runner for aldol-engine on aldol-burn-vm2.
# TEMPORARY: the burn VM auto-deletes 2026-11-26 00:00 KST.
# Usage: RUNNER_TOKEN=<registration token> sh install-runner-vm2.sh
# The runner MUST NOT run as root: config.sh refuses root ("Must not run with sudo"),
# so install into a dedicated non-root user and run the service as that user.
set -e

REPO_URL="https://github.com/aldol2678/aldol-engine"
RUNNER_NAME="aldol-burn-vm2"
RUNNER_LABELS="burn-vm2"
RUNNER_VERSION="2.338.2"
RUNNER_USER="actions-runner"
RUNNER_DIR="/home/$RUNNER_USER/actions-runner"

[ -n "$RUNNER_TOKEN" ] || { echo "RUNNER_TOKEN is empty — create one at repo Settings > Actions > Runners > New self-hosted runner" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found on this VM" >&2; exit 1; }
if ! command -v git >/dev/null; then
  echo "installing git"
  apt-get install -y git || { echo "git install failed" >&2; exit 1; }
fi

# Dedicated non-root user for the runner (config.sh refuses root).
if ! id -u "$RUNNER_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$RUNNER_USER"
  echo "created user $RUNNER_USER"
fi

mkdir -p "$RUNNER_DIR"
chown "$RUNNER_USER:$RUNNER_USER" "$RUNNER_DIR"
cd "$RUNNER_DIR"

if [ ! -f "actions-runner-linux-x64-$RUNNER_VERSION.tar.gz" ]; then
  echo "downloading runner $RUNNER_VERSION"
  curl -o "actions-runner-linux-x64-$RUNNER_VERSION.tar.gz" -L \
    "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz"
fi
tar xzf "actions-runner-linux-x64-$RUNNER_VERSION.tar.gz"
chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_DIR"

# Configure as the non-root user (config.sh blocks root/sudo).
echo "configuring runner as $RUNNER_USER"
su "$RUNNER_USER" -c "./config.sh --url $REPO_URL --token $RUNNER_TOKEN --name $RUNNER_NAME --labels $RUNNER_LABELS --unattended --replace"

# Register as a systemd service (runs as the runner user); fall back to nohup.
if ./svc.sh install "$RUNNER_USER" && ./svc.sh start; then
  echo "runner service installed and started"
else
  echo "svc.sh failed — falling back to nohup run.sh as $RUNNER_USER"
  nohup su "$RUNNER_USER" -c "./run.sh" > /var/log/gh-runner.log 2>&1 &
fi
echo "done"
