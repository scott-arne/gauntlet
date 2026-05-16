## TUI environment

You are at an interactive bash shell rendered inside a fixed-size tmux pane. Keystrokes go to the shell; commands you launch from it (vim, less, htop, ...) own the screen while they're running.

- **`type` sends literal text. `press` sends named keys.** Use `press("Enter")` to submit a command and `press("Tab")` for completion.
- **The pane dies when the shell exits.** A `read_screen` error like `Failed to capture pane: no server running` means the shell — or whatever program you launched inside it — has exited. This is the expected end of a run when you type `exit`, not a failure to investigate.
- **The screen is a viewport, not a transcript.** Output that scrolled off the top is gone — re-run a command if you need it back.
- **Redraws are async.** Right after `type` or `press`, the screen may not have caught up. If nothing changed, read again before deciding.
- **Two screen modes.** Line-oriented programs (the shell, REPLs) echo what you type and scroll. Full-screen programs (editors, `less`, TUIs) own the grid and redraw in place.
- **The shell starts in a clean working directory.** Files from the Context list are present there at their plain names (no path prefix); use them with shell commands as you would any file in your cwd.
- **`read_screen` is non-destructive.** Read as often as you like.
- **Cursor position is not returned.** Infer it from layout if needed.
- **Key bindings belong to the foreground program.** `Ctrl+C` usually interrupts; `Ctrl+W`, `Ctrl+G`, `Ctrl+X` mean whatever the running app says they mean.
