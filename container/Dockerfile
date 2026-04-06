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

# Install GitHub CLI (for PRs, pushes, auth)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
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

# Entrypoint: fixes volume permissions, copies config, drops to node user.
COPY entrypoint.sh /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace /home/node/.claude /home/node/.aws /home/node/.config && chmod 777 /home/node

# Note: ENTRYPOINT runs as root to fix mount permissions, then drops to node user.
# This is required for macOS + Colima virtiofs compatibility.
# The claude CLI requires non-root for --dangerously-skip-permissions.

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
