# TODO Fixture — Design

A unified end-to-end fixture for Gauntlet: one TODO app, three frontends
(CLI, TUI, Web), one set of cards that runs against any of them. Used to
exercise the CLI/TUI/Web adapters and catch driver regressions against a
deterministic, known-good target.

## Motivation

Gauntlet has three adapters but no first-party fixture that exercises all
three with a shared card library. The tutorial webapp covers Web; CLI
and TUI coverage is ad-hoc. A unified TODO fixture gives us:

- A stable, dumb-on-purpose target whose only job is to be predictable.
- Adapter regression coverage: when a driver breaks, a card fails the
  same way regardless of which adapter is in the loop.
- A second worked example alongside the tutorial — useful for new users
  reading the repo to learn what a fixture looks like.

The fixture is *not* trying to challenge agent capability. Cards are
deliberately reachable; the regression signal is the adapter's ability
to drive the app to those reachable outcomes.

## Architecture

One TODO core, three thin frontends.

```
examples/todo/
├── README.md
├── CLAUDE.md            # context tree: "this is a UI-adapter fixture; use the UI"
├── core.ts              # data model + operations + state I/O
├── cli.ts               # single-shot CLI
├── tui.ts               # Ink-based, keyboard-driven
├── web/
│   ├── server.ts        # Bun HTTP server
│   └── public/index.html
└── .gauntlet/
    └── stories/
        ├── 01-add-one.md
        ├── 02-add-three.md
        ├── 03-toggle-one.md
        ├── 04-toggle-selectively.md
        ├── 05-delete-one.md
        ├── 06-filter-active.md
        ├── 07-clear-completed.md
        └── 08-count-readback.md
```

`core.ts` is the single source of truth for behavior. The three frontends
import it and never touch the state file directly. Bugs get fixed in one
place; the frontends are presentation only.

## Data model

```ts
type Filter = "all" | "active" | "completed";

interface TodoItem {
  id: string;   // 4-char id from a small unambiguous alphabet (lowercase letters + digits, no 0/1/l/o), generated on add
  text: string;
  done: boolean;
}

interface TodoState {
  items: TodoItem[];   // insertion order
  filter: Filter;
}
```

Item IDs are short, readable, and visibly not positional. Insertion order
is preserved; the frontends render in that order.

`core.ts` exports:

- `loadState(path?: string): TodoState` — reads `$TODO_STATE_FILE`, or the
  argument, or `./.todo-state.json`. Returns an empty state if the file
  doesn't exist.
- `saveState(state, path?): void`
- `addItem(state, text): TodoItem`
- `toggleItem(state, id): TodoItem | null`
- `deleteItem(state, id): boolean`
- `setFilter(state, filter): void`
- `clearCompleted(state): number` — returns count removed
- `visibleItems(state): TodoItem[]` — items after `state.filter` applied
- `activeCount(state): number` — count of items where `!done`

## State persistence

State lives at `$TODO_STATE_FILE` (env var). Default: `./.todo-state.json`
in cwd. The Gauntlet harness sets this to a fresh tempfile per run,
giving each card run an isolated state.

JSON format, pretty-printed. The file is an internal implementation
detail of the fixture — cards do not reference it, and the harness does
not read it for verdicts (see "Verdict mechanism" below).

CLI writes after every mutation. TUI and Web load at startup, write after
every mutation. No locking; concurrent multi-frontend writes are out of
scope (no card requires it).

## Frontends

### CLI

Single-shot. Each invocation: load state, mutate, save, exit.

```
todo add "buy milk"           Add an item; print its row.
todo list                     Print visible items (respects filter).
todo list --all               Ignore filter, print everything.
todo toggle <id>              Flip done on the item with that id.
todo rm <id>                  Delete by id.
todo filter <all|active|done> Set filter.
todo clear-completed          Remove all items where done=true.
todo                          Alias for `list`.
```

Output format, one item per line:

```
a3xq  [ ] buy milk
b7kn  [x] walk dog
```

Footer line on `list`:

```
Filter: active — 2 items left (showing 2 of 3)
```

When filter is `all`, the footer is:

```
3 items left
```

Filter visibility in CLI output is what makes card 06 (filter-active)
work — the agent must observe filter state through the footer, not infer
it.

### TUI

Long-running. Ink-based. Reads state on boot; persists after every
mutation.

Header:
```
TODO — 2 items left — filter: active
```

Body: visible items, cursor row highlighted (reverse video).
Each row: `[ ] text` or `[x] text`, no ID column (TUI uses cursor position).

Footer:
```
[i] add  [j/k] move  [space] toggle  [d] delete  [1/2/3] filter  [c] clear-completed  [q] quit
```

Keybinds:
- `i` — enter input mode; type; `Enter` adds, `Esc` cancels.
- `j` / `k` — move cursor down / up.
- `Space` or `Enter` — toggle the cursor item's done state.
- `d` — delete the cursor item.
- `1` / `2` / `3` — set filter to all / active / completed.
- `c` — clear completed.
- `q` — quit.

### Web

Long-running Bun server, classic TodoMVC layout served from a single
HTML page with vanilla JS (no framework — keeps the surface readable).

Top to bottom:

- Title: "TODO"
- Text input with placeholder "What needs doing?" — Enter adds.
- Item list. Each row:
  - Checkbox (toggle done)
  - Text (struck-through when done)
  - `✕` button (always visible, no hover-to-reveal — hover-only is
    fragile for adapters)
- Footer:
  - `N items left` on the left
  - Three filter buttons in the middle: `All` `Active` `Completed`,
    with the selected one styled distinctly (background fill, not just
    bold, so a screenshot or DOM read both work).
  - `Clear completed` button on the right.

Filter buttons are `<button>` elements, never `<select>`. The memory
`project_gauntlet_select_cdp_trap` documents why native `<select>` is
not viable in fixture webapps.

State persistence: in-memory while running, write `state.json` after
every mutation, read it at startup. Restart-survivable.

Port: `$TODO_WEB_PORT` (env), default 7891. (Chosen to avoid collision
with the tutorial webapp on 7890.)

## Cards

Eight stories at `examples/todo/.gauntlet/stories/`. All use the
Vampire Accountant cast (Fred / Deborah / Quinn) for continuity with the
tutorial. All tagged `tutorial, todo`. Persona-bound (`You are <Name>.`),
adapter-neutral in voice, outcome-shaped per the `writing-gauntlet-stories`
skill.

### 01-add-one.md

```markdown
---
id: tutorial-todo-01-add-one
title: Add a single todo and confirm it appears in the active list
status: ready
tags: tutorial, todo
---

You are Fred. Open the todo app and capture a fresh item for the
evening: *finalize Cresswell estate ledger*. After adding it,
confirm the new item is in the list and is not yet done.

## Acceptance Criteria

- The list shows an item whose text is "finalize Cresswell
  estate ledger"
- That item is not marked done
- The "items left" footer reflects the addition (one more
  active item than the starting state)
```

### 02-add-three.md

```markdown
---
id: tutorial-todo-02-add-three
title: Add three todos in a chosen order
status: ready
tags: tutorial, todo
---

You are Fred. You're staging tonight's accounts work. Add three
items in this order: *post late-fee notice*, *reconcile Quinn's
invoice*, *file Deborah's century-end summary*.

## Acceptance Criteria

- All three items appear in the list
- They appear in the order given
- None are marked done
- The "items left" footer shows three more active items than
  the starting state
```

### 03-toggle-one.md

```markdown
---
id: tutorial-todo-03-toggle-one
title: Add an item and mark it done
status: ready
tags: tutorial, todo
---

You are Fred. Add an item: *call back the assessor*. The
assessor calls you back just as you finish writing it down, so
mark the item done.

## Acceptance Criteria

- An item with text "call back the assessor" is present
- That item is marked done (checkbox / strike-through / `[x]`
  indicator visible)
- The "items left" footer does not count this item among
  active
```

### 04-toggle-selectively.md

```markdown
---
id: tutorial-todo-04-toggle-selectively
title: Mark a specific item done from a list of three
status: ready
tags: tutorial, todo
---

You are Fred. Stage three tasks for the evening rounds: *empty
trap one*, *empty trap two*, *empty trap three*. After all
three are listed, you remember trap two was already cleared
earlier — mark only that one done.

## Acceptance Criteria

- All three items are present
- Exactly one item is marked done
- The done item has text "empty trap two"
- The other two items remain active
```

### 05-delete-one.md

```markdown
---
id: tutorial-todo-05-delete-one
title: Remove a specific item from the list
status: ready
tags: tutorial, todo
---

You are Fred. Stage three tasks: *send Quinn an invoice*,
*draft polite refusal to publisher*, *renew taxidermy permit*.
The publisher just rescinded, so the refusal is moot — remove
that item.

## Acceptance Criteria

- The list contains exactly two items
- The remaining items are "send Quinn an invoice" and "renew
  taxidermy permit", in that order
- No item with text "draft polite refusal to publisher"
  remains
```

### 06-filter-active.md

```markdown
---
id: tutorial-todo-06-filter-active
title: View only the unfinished tasks
status: ready
tags: tutorial, todo
---

You are Fred. Stage four tasks: *replace garden stake*, *forward
Deborah's mail*, *settle the milkman*, *fix the back gate*. Two
were finished earlier in the day — mark *forward Deborah's mail*
and *settle the milkman* done. Then narrow the view so only the
unfinished work is visible.

## Acceptance Criteria

- The visible list shows exactly the two active items:
  "replace garden stake" and "fix the back gate"
- The two done items are NOT visible in the current view
- The view's filter indicator shows that the "active" subset
  is selected (the items are filtered, not deleted)
```

### 07-clear-completed.md

```markdown
---
id: tutorial-todo-07-clear-completed
title: Remove all finished items in one stroke
status: ready
tags: tutorial, todo
---

You are Fred. Stage four end-of-month tasks: *pay rent*,
*deposit cash*, *post recipe to ledger blog*, *call accountant
back*. Pay rent and deposit cash get done first; mark both.
Then sweep the finished items off the list in one go.

## Acceptance Criteria

- The list contains exactly two items: "post recipe to ledger
  blog" and "call accountant back"
- Both remaining items are active
- No item with text "pay rent" or "deposit cash" is present
  in any view (the items are gone, not filtered away)
```

### 08-count-readback.md

```markdown
---
id: tutorial-todo-08-count-readback
title: Read the remaining count from the footer
status: ready
tags: tutorial, todo
---

You are Fred. Stage five tasks for the week: *visit the lawyer*,
*sort the cellar*, *ring Quinn*, *bury the broken ledger*,
*order new ink*. Two get done during the day — mark *sort the
cellar* and *ring Quinn* done. Report how many tasks remain.

## Acceptance Criteria

- All five items were added
- Exactly two are marked done: "sort the cellar" and "ring
  Quinn"
- The reported remaining count is 3
- The reported count cites what is visible in the app's count
  area, not an inferred count
```

## Context tree

`examples/todo/CLAUDE.md` carries the meta-instruction that the cards
deliberately omit (per the skill: ACs must be screen-observable, so
"don't edit the state file" lives in context, not in every AC):

```markdown
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
```

## Verdict mechanism

Standard Gauntlet flow: cards verdict via the LLM auditor reading the
agent's transcript. The fixture's `state.json` is not consumed by the
harness for verdicts.

This stays consistent with every other Gauntlet card and avoids adding
a new mechanism. If, in practice, auditor noise starts hiding real
adapter regressions (cards passing with broken adapters because the
auditor was credulous), the natural next step is to add an optional
`expect:` block to cards and a state-reader hook in the runtime. That
work is deferred until specific failures motivate the shape.

## Out of scope

- **Edit-in-place** (TodoMVC's double-click-to-edit). Adds a mode without
  much new adapter coverage.
- **Multi-user, auth, sessions.** The tutorial webapp covers that
  surface.
- **Cross-adapter cards** ("add via CLI, verify in Web"). Possible later
  via the shared `state.json`; not in v1.
- **Per-card adapter tagging.** All eight cards target all three
  adapters. If empirical runs show a card doesn't translate to a
  surface, add adapter-restricting tags then.
- **Machine-checkable assertions on state.json.** Deferred until auditor
  flakiness demonstrates the need.
- **Concurrency / locking on state.json.** No card requires it.

## Open questions

None known. All architectural forks resolved during brainstorming.

## Next step

Implementation plan via `superpowers:writing-plans`.
