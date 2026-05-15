# TODO fixture

A unified test target for Gauntlet's three adapters (CLI, TUI, Web).
One TODO core, three thin frontends, eight portable cards.

## Running by hand

```bash
# CLI (single-shot)
bun run examples/todo/cli.ts add "buy milk"
bun run examples/todo/cli.ts list

# TUI
bun run examples/todo/tui.tsx

# Web
bun run examples/todo/web/server.ts
# listens on $TODO_WEB_PORT (default 7891)
```

All three frontends honor `$TODO_STATE_FILE` (default `./.todo-state.json`).
Gauntlet's harness sets this per run for isolation.

## Running cards via Gauntlet

Run from the gauntlet project root (so the path-relative `--target`
expansions resolve correctly):

```bash
cd "$(git rev-parse --show-toplevel)"

# CLI — the adapter spawns a bash shell for the agent; target is the
# command name the agent invokes inside it.
gauntlet run examples/todo/.gauntlet/stories/01-add-one.md \
  --adapter cli \
  --target "bun run $(pwd)/examples/todo/cli.ts" \
  --max-time 3m

# TUI — the adapter spawns the target program directly in a tmux pane.
gauntlet run examples/todo/.gauntlet/stories/01-add-one.md \
  --adapter tui \
  --target "bun run $(pwd)/examples/todo/tui.tsx"

# Web — start the server in another terminal, then point gauntlet at it.
./examples/todo/run-web.sh &
gauntlet run examples/todo/.gauntlet/stories/01-add-one.md \
  --adapter web \
  --target "http://localhost:7891"
```

## Don't use this for anything real

The TODO core is a fixture — single JSON file, no locking, no auth,
no validation beyond "is this a string". It exists to give Gauntlet's
CLI/TUI/Web adapters a deterministic regression target. Treat the
source as a fixture, not a starter.
