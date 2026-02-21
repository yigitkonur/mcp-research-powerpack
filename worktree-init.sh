#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# worktree-init.sh - Bootstrap a git worktree for mcp-research-powerpack
#
# Run this script from the root of a freshly-created worktree.
# It copies local config from the main repo and installs dependencies.
#
# Usage:
#   git worktree add /path/to/worktree <branch>
#   cd /path/to/worktree
#   bash worktree-init.sh
###############################################################################

MAIN_REPO="/Users/yigitkonur/dev/projects/mcp-research-powerpack"
WORKTREE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Initializing worktree at: ${WORKTREE_DIR}"
echo "    Main repo: ${MAIN_REPO}"

# --------------------------------------------------------------------------
# 1. Copy .env from main repo (if it exists)
# --------------------------------------------------------------------------
if [[ -f "${MAIN_REPO}/.env" ]]; then
  if [[ ! -f "${WORKTREE_DIR}/.env" ]]; then
    cp "${MAIN_REPO}/.env" "${WORKTREE_DIR}/.env"
    echo "==> Copied .env from main repo"
  else
    echo "==> .env already exists in worktree, skipping"
  fi
else
  echo "==> No .env in main repo, skipping (see .env.example)"
fi

# --------------------------------------------------------------------------
# 2. Copy .claude/settings.local.json from main repo (if it exists)
# --------------------------------------------------------------------------
if [[ -f "${MAIN_REPO}/.claude/settings.local.json" ]]; then
  mkdir -p "${WORKTREE_DIR}/.claude"
  if [[ ! -f "${WORKTREE_DIR}/.claude/settings.local.json" ]]; then
    cp "${MAIN_REPO}/.claude/settings.local.json" "${WORKTREE_DIR}/.claude/settings.local.json"
    echo "==> Copied .claude/settings.local.json from main repo"
  else
    echo "==> .claude/settings.local.json already exists in worktree, skipping"
  fi
else
  echo "==> No .claude/settings.local.json in main repo, skipping"
fi

# --------------------------------------------------------------------------
# 3. Install dependencies with pnpm
# --------------------------------------------------------------------------
echo "==> Installing dependencies with pnpm install --frozen-lockfile ..."
cd "${WORKTREE_DIR}"
pnpm install --frozen-lockfile 2>&1 | tail -1
echo "==> Dependencies installed"

# --------------------------------------------------------------------------
# 4. Build the project
# --------------------------------------------------------------------------
echo "==> Building project ..."
pnpm build 2>&1 | tail -3
echo "==> Build complete"

echo ""
echo "==> Worktree ready at: ${WORKTREE_DIR}"
echo "    Run 'pnpm dev' to start in development mode."
