# TODO fixture

A Gauntlet adapter-regression fixture. One TODO core, three frontends
(CLI / TUI / Web), one shared set of cards. The card you're running
narrates the work — this file just tells you the surface.

## CLI commands

`<target>` below is the literal string the system prompt names as the
command you are exercising. Use it as a prefix.

- `<target> add "<text>"` — add an item. Prints the new row.
- `<target> list` — list items. Respects the current filter. Pass
  `--all` to show everything regardless of filter.
- `<target> toggle <id>` — flip an item's done state.
- `<target> rm <id>` — remove the item.
- `<target> filter <all|active|completed>` — set the filter; also
  prints the list.
- `<target> clear-completed` — remove every item marked done.

`<target>` with no args is an alias for `list`.

Output format, one item per line:
```
a3xq  [ ] buy milk
b7kn  [x] walk dog
```
Footer always begins with `Filter: <name> — N item(s) left`. The
`(showing X of Y)` clause appears when items are hidden by the filter.

## TUI keybinds

Inside the TUI: `i` to add (Enter commits, Esc cancels), `j` / `k`
to move the cursor, `Space` to toggle, `d` to delete, `1` / `2` / `3`
for all / active / completed filters, `c` to clear completed, `q` to
quit. Header shows the count and current filter; the cursor row is
reverse-video.

## Web surface

Classic TodoMVC layout: text input at the top, list below with a
checkbox and ✕ delete button per row, footer with `N items left`,
filter buttons (All / Active / Completed — the selected one is
styled distinctly), and a `Clear completed` button. Filter is a
button, not a `<select>`.

## Item IDs

The CLI prints IDs (`a3xq` etc.) that are stable for the lifetime of
an item within a run but differ across fresh runs. Don't memorize them
across runs.

## Don't edit state directly

The on-disk state file (`$TODO_STATE_FILE`) is an implementation
detail. Card outcomes are observable from the app's surface (stdout /
TUI pane / Web DOM). Use the app's UI — don't bypass it by editing
the JSON.
