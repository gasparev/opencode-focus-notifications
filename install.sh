#!/usr/bin/env bash
set -euo pipefail

REPO="gasparev/opencode-focus-notifications"
PLUGIN_DIR="${HOME}/.config/opencode/plugins"
PLUGIN_FILE="${PLUGIN_DIR}/notification.js"
RAW_URL="https://raw.githubusercontent.com/${REPO}/main/index.js"

echo "Installing opencode-focus-notifications..."

# Create plugins directory if needed
mkdir -p "${PLUGIN_DIR}"

# Download plugin
if command -v curl &>/dev/null; then
  curl -fsSL "${RAW_URL}" -o "${PLUGIN_FILE}"
elif command -v wget &>/dev/null; then
  wget -qO "${PLUGIN_FILE}" "${RAW_URL}"
else
  echo "Error: curl or wget required" >&2
  exit 1
fi

echo "Installed to ${PLUGIN_FILE}"
echo "Restart OpenCode to activate."
