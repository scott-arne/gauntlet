#!/usr/bin/env bash
# Launcher for the Gauntlet Web adapter target. Isolated state
# file per invocation, then runs the server in the foreground.
# Gauntlet's Web runner expects the server already up — invoke
# this in one terminal, then run `gauntlet run` against the URL
# in another.
set -e
SCRATCH="$(mktemp -d -t todo-web-XXXXXX)"
export TODO_STATE_FILE="$SCRATCH/state.json"
export TODO_WEB_PORT="${TODO_WEB_PORT:-7891}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[[ -d "$REPO_ROOT/examples/todo" ]] || {
  echo "launcher: REPO_ROOT wrong: $REPO_ROOT" >&2; exit 1;
}
echo "todo-web: $TODO_STATE_FILE on :$TODO_WEB_PORT"
exec bun run "$REPO_ROOT/examples/todo/web/server.ts"
