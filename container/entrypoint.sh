#!/bin/bash
set -e
# Fix permissions on mounted workspace dirs
# Colima virtiofs maps the macOS host user to root inside the Linux VM,
# so host-created dirs appear as root:root and block the node user.
chmod -R a+rwx /workspace/group /workspace/ipc 2>/dev/null || true
# Copy global claude config file (feature flags, account info)
if [ -f /home/node/.claude-host-config.json ]; then
  cp /home/node/.claude-host-config.json /home/node/.claude.json
  chown node:node /home/node/.claude.json 2>/dev/null || true
fi
# Copy OAuth credentials from host mount into the per-group .claude dir
# so the claude CLI can authenticate
if [ -f /home/node/.claude-host-creds/.credentials.json ]; then
  cp /home/node/.claude-host-creds/.credentials.json /home/node/.claude/.credentials.json
  chown node:node /home/node/.claude/.credentials.json 2>/dev/null || true
fi
# Copy gh CLI config from host mount so containers can push to GitHub
if [ -d /home/node/.gh-host-config ]; then
  mkdir -p /home/node/.config/gh
  cp -r /home/node/.gh-host-config/* /home/node/.config/gh/
  chown -R node:node /home/node/.config/gh 2>/dev/null || true
fi
# Read stdin before dropping privileges
cat > /tmp/input.json
chown node:node /tmp/input.json
# Run agent as node user
exec su node -s /bin/bash -c "node /app/dist/index.js < /tmp/input.json"
