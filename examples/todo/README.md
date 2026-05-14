# TODO fixture

A unified test target for Gauntlet's three adapters (CLI, TUI, Web).
One TODO core, three thin frontends, eight portable cards.

```bash
# CLI
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

## Don't use this for anything real

The TODO core is a fixture — single JSON file, no locking, no auth,
no validation beyond "is this a string". It exists to give Gauntlet's
CLI/TUI/Web adapters a deterministic regression target. Treat the
source as a fixture, not a starter.
