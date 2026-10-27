#!/bin/sh
# Updates the runtime checkout to the latest main and restarts the daemon.
# The runtime checkout is separate from any working copy, so unfinished work never runs.
#
#   scripts/deploy.sh <instance> [runtime-dir]
#
# Default runtime dir: ~/.local/share/dsptchr/app (a clone of the repository on main).
set -eu

INSTANCE="${1:?usage: deploy.sh <instance> [runtime-dir]}"
APP="${2:-$HOME/.local/share/dsptchr/app}"

git -C "$APP" fetch --quiet origin main
git -C "$APP" checkout --quiet main
git -C "$APP" merge --quiet --ff-only origin/main
(cd "$APP" && pnpm install --frozen-lockfile --silent)
launchctl kickstart -k "gui/$(id -u)/dev.dsptchr.$INSTANCE"
echo "deployed $(git -C "$APP" rev-parse --short HEAD) to $INSTANCE"
