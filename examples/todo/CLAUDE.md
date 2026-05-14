# TODO fixture

This is a UI-adapter regression fixture for Gauntlet. The app exists to
give the CLI/TUI/Web adapters a predictable target.

When running cards against this app:

- Use the app's UI (CLI commands, TUI keybinds, Web controls). Do not
  edit the on-disk state file directly — that bypasses the very thing
  being tested.
- The on-disk state file is an implementation detail. Card outcomes are
  observable from the app's own surface (stdout, TUI pane, Web DOM).
- Item IDs printed by the CLI (`a3xq`, etc.) are stable within a run
  but differ across fresh runs. Don't memorize them across runs.
