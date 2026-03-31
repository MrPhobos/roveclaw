# NanoClaw Agent Container -- Rove (CLI-only, no browser automation)
# Runs Claude Code CLI in isolated Linux container

FROM node:22-slim

RUN apt-get update && apt-get install -y \
    curl \
    git \
    jq \
    openssh-client \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install claude-code CLI globally (the CLI the runner spawns)
RUN npm install -g @anthropic-ai/claude-code@latest

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra \
    /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create home dirs for node user
RUN mkdir -p /home/node/.config /home/node/.aws /home/node/.claude

# Root-level init script: fixes volume mount permissions, then drops to node user.
# Required for macOS + Colima virtiofs where host-mounted dirs appear as root:root inside the guest VM.
RUN printf '#!/bin/bash\nset -e\n# Fix permissions on mounted workspace dirs\n# Colima virtiofs maps the macOS host user to root inside the Linux VM,\n# so host-created dirs appear as root:root and block the node user.\nchmod -R a+rwx /workspace/group /workspace/ipc 2>/dev/null || true\n# Copy OAuth credentials from read-only host mount to writable claude config dir.\n# CLAUDE_CONFIG_DIR is NOT used - claude needs its full config dir to be writable\n# (session storage, settings). We copy only the credentials file at startup.\nif [ -f /home/node/.claude-host-creds/.credentials.json ]; then\n  mkdir -p /home/node/.claude\n  cp /home/node/.claude-host-creds/.credentials.json /home/node/.claude/.credentials.json\n  chown node:node /home/node/.claude/.credentials.json 2>/dev/null || true\nfi\n# Read stdin before dropping privileges\ncat > /tmp/input.json\nchown node:node /tmp/input.json\n# Run agent as node user using pre-built dist (avoids redundant tsc recompile)\nexec su node -s /bin/bash -c "node /app/dist/index.js < /tmp/input.json"\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace /home/node/.claude /home/node/.aws /home/node/.config && chmod 777 /home/node

# Note: ENTRYPOINT runs as root to fix mount permissions, then drops to node user.
# This is required for macOS + Colima virtiofs compatibility.
# The claude CLI requires non-root for --dangerously-skip-permissions.

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
