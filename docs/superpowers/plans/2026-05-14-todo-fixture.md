# TODO Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified TODO fixture under `examples/todo/` with one shared TODO core, three thin frontends (CLI, TUI, Web), and eight portable Gauntlet cards that run against any adapter.

**Architecture:** Single `core.ts` holds the data model and state I/O. CLI, TUI, and Web each import it; none touches the JSON state file directly. State lives at `$TODO_STATE_FILE` (default `./.todo-state.json`), giving the Gauntlet harness per-run isolation.

**Tech Stack:** TypeScript / Bun. CLI is single-shot argv-dispatched. TUI uses Ink (React for terminals). Web uses `Bun.serve` + vanilla HTML/JS (no framework, mirrors `examples/tutorial/webapp/`). Tests use `bun:test`.

**Spec:** `docs/superpowers/specs/2026-05-14-todo-fixture-design.md` (commits `28ffc4c`, `d289a81`).

**Linear:** [PRI-1604](https://linear.app/prime-radiant/issue/PRI-1604/).

**Build order:** core → CLI (cheapest to verify) → TUI → Web. Cards land alongside the CLI so we can smoke-test them as soon as the CLI works.

---

## File structure

```
examples/todo/
├── README.md                      # T1
├── CLAUDE.md                      # T1
├── core.ts                        # T2–T7
├── cli.ts                         # T8
├── tui.tsx                        # T11–T12  (.tsx for Ink/JSX)
├── web/
│   ├── server.ts                  # T14–T16
│   └── public/index.html          # T14–T16
└── .gauntlet/
    └── stories/
        ├── 01-add-one.md          # T10
        ├── 02-add-three.md        # T10
        ├── 03-toggle-one.md       # T10
        ├── 04-toggle-selectively.md
        ├── 05-delete-one.md
        ├── 06-filter-active.md
        ├── 07-clear-completed.md
        └── 08-count-readback.md

test/examples/todo/
├── core.test.ts                   # T2–T7
└── cli.test.ts                    # T8
```

`core.ts` is the only file that reads or writes `state.json`. The three frontends import its operations and never touch JSON directly. This is the single point of behavior; bugs get fixed once.

---

## Task 1: Scaffold the fixture directory

**Files:**
- Create: `examples/todo/README.md`
- Create: `examples/todo/CLAUDE.md`
- Create: `examples/todo/.gauntlet/` (empty dir; `.gitkeep` if needed)
- Create: `examples/todo/.gauntlet/stories/` (empty dir; `.gitkeep` if needed)

- [ ] **Step 1: Create the fixture root and write README.md**

```bash
mkdir -p examples/todo/.gauntlet/stories
mkdir -p examples/todo/web/public
```

Content for `examples/todo/README.md`:

```markdown
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
```

Content for `examples/todo/CLAUDE.md`:

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

- [ ] **Step 2: Commit the scaffolding**

```bash
git add examples/todo/README.md examples/todo/CLAUDE.md
git commit -m "examples/todo: scaffolding (README, CLAUDE.md) (PRI-1604)"
```

---

## Task 2: core.ts — types and state I/O

**Files:**
- Create: `examples/todo/core.ts`
- Create: `test/examples/todo/core.test.ts`

- [ ] **Step 1: Write the failing test for empty-state load**

Content for `test/examples/todo/core.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadState,
  saveState,
  type TodoState,
} from "../../../examples/todo/core";

let tmp: string;
let stateFile: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "todo-core-"));
  stateFile = join(tmp, "state.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadState", () => {
  test("returns empty state when file does not exist", () => {
    const s = loadState(stateFile);
    expect(s).toEqual({ items: [], filter: "all" });
  });

  test("reads an existing state file", () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        items: [{ id: "a3xq", text: "buy milk", done: false }],
        filter: "active",
      }),
    );
    const s = loadState(stateFile);
    expect(s.items.length).toBe(1);
    expect(s.items[0]?.text).toBe("buy milk");
    expect(s.filter).toBe("active");
  });
});

describe("saveState", () => {
  test("writes pretty-printed JSON", () => {
    const s: TodoState = {
      items: [{ id: "a3xq", text: "buy milk", done: false }],
      filter: "all",
    };
    saveState(s, stateFile);
    expect(existsSync(stateFile)).toBe(true);
    const raw = readFileSync(stateFile, "utf8");
    expect(raw).toContain("\n");
    expect(JSON.parse(raw)).toEqual(s);
  });

  test("save + load roundtrip preserves state", () => {
    const s: TodoState = {
      items: [
        { id: "a3xq", text: "first", done: false },
        { id: "b7kn", text: "second", done: true },
      ],
      filter: "completed",
    };
    saveState(s, stateFile);
    expect(loadState(stateFile)).toEqual(s);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test test/examples/todo/core.test.ts`
Expected: FAIL — `Cannot find module '../../../examples/todo/core'`.

- [ ] **Step 3: Implement core.ts (types + state I/O)**

Content for `examples/todo/core.ts`:

```ts
// Shared TODO model + state I/O for the Gauntlet fixture under
// examples/todo. All three frontends (cli, tui, web) import from
// here; nothing else touches the on-disk JSON.
//
// State path resolution: explicit argument > $TODO_STATE_FILE >
// ./.todo-state.json. The Gauntlet harness sets $TODO_STATE_FILE
// per run for isolation.
//
// This is a fixture. No locking, no schema migration, no validation
// beyond what the type system gives us. Don't use as a starter.

import { existsSync, readFileSync, writeFileSync } from "fs";

export type Filter = "all" | "active" | "completed";

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

export interface TodoState {
  items: TodoItem[];
  filter: Filter;
}

const DEFAULT_STATE_FILE = "./.todo-state.json";

export function resolveStatePath(arg?: string): string {
  if (arg) return arg;
  const env = process.env.TODO_STATE_FILE;
  if (env && env.length > 0) return env;
  return DEFAULT_STATE_FILE;
}

export function loadState(path?: string): TodoState {
  const file = resolveStatePath(path);
  if (!existsSync(file)) {
    return { items: [], filter: "all" };
  }
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as TodoState;
  return {
    items: parsed.items ?? [],
    filter: parsed.filter ?? "all",
  };
}

export function saveState(state: TodoState, path?: string): void {
  const file = resolveStatePath(path);
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `bun test test/examples/todo/core.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add examples/todo/core.ts test/examples/todo/core.test.ts
git commit -m "examples/todo: core types + state I/O (PRI-1604)"
```

---

## Task 3: core.ts — addItem

**Files:**
- Modify: `examples/todo/core.ts`
- Modify: `test/examples/todo/core.test.ts`

- [ ] **Step 1: Append failing tests for addItem**

Append to `test/examples/todo/core.test.ts`:

```ts
import { addItem } from "../../../examples/todo/core";

describe("addItem", () => {
  test("appends an active item and returns it", () => {
    const s: TodoState = { items: [], filter: "all" };
    const added = addItem(s, "buy milk");
    expect(s.items.length).toBe(1);
    expect(s.items[0]).toBe(added);
    expect(added.text).toBe("buy milk");
    expect(added.done).toBe(false);
  });

  test("preserves insertion order across multiple adds", () => {
    const s: TodoState = { items: [], filter: "all" };
    addItem(s, "first");
    addItem(s, "second");
    addItem(s, "third");
    expect(s.items.map((i) => i.text)).toEqual(["first", "second", "third"]);
  });

  test("generated IDs are 4 chars from the unambiguous alphabet", () => {
    const s: TodoState = { items: [], filter: "all" };
    for (let i = 0; i < 50; i++) addItem(s, `item ${i}`);
    for (const item of s.items) {
      expect(item.id).toMatch(/^[a-km-np-z2-9]{4}$/);
    }
  });

  test("IDs are unique within a state", () => {
    const s: TodoState = { items: [], filter: "all" };
    for (let i = 0; i < 100; i++) addItem(s, `item ${i}`);
    const seen = new Set(s.items.map((i) => i.id));
    expect(seen.size).toBe(s.items.length);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test test/examples/todo/core.test.ts`
Expected: FAIL — `addItem` is not exported.

- [ ] **Step 3: Implement addItem and the ID generator**

Append to `examples/todo/core.ts`:

```ts
// Alphabet: a-k, m, n, p-z, 2-9 (no 0/1/l/o, no ambiguous chars).
// 30 symbols, 4 chars => 810,000 distinct ids — plenty for a fixture.
const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function generateId(existing: Set<string>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let id = "";
    for (let i = 0; i < 4; i++) {
      id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    }
    if (!existing.has(id)) return id;
  }
  throw new Error("todo: failed to generate a unique id after 1000 attempts");
}

export function addItem(state: TodoState, text: string): TodoItem {
  const existing = new Set(state.items.map((i) => i.id));
  const item: TodoItem = {
    id: generateId(existing),
    text,
    done: false,
  };
  state.items.push(item);
  return item;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `bun test test/examples/todo/core.test.ts`
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add examples/todo/core.ts test/examples/todo/core.test.ts
git commit -m "examples/todo: core addItem + ID generator (PRI-1604)"
```

---

## Task 4: core.ts — toggleItem

**Files:**
- Modify: `examples/todo/core.ts`
- Modify: `test/examples/todo/core.test.ts`

- [ ] **Step 1: Append failing tests for toggleItem**

Append to `test/examples/todo/core.test.ts`:

```ts
import { toggleItem } from "../../../examples/todo/core";

describe("toggleItem", () => {
  test("flips done from false to true", () => {
    const s: TodoState = { items: [], filter: "all" };
    const added = addItem(s, "x");
    const toggled = toggleItem(s, added.id);
    expect(toggled?.done).toBe(true);
    expect(s.items[0]?.done).toBe(true);
  });

  test("flips done from true to false", () => {
    const s: TodoState = { items: [], filter: "all" };
    const added = addItem(s, "x");
    toggleItem(s, added.id);
    const toggled = toggleItem(s, added.id);
    expect(toggled?.done).toBe(false);
  });

  test("returns null for unknown id, no mutation", () => {
    const s: TodoState = { items: [], filter: "all" };
    addItem(s, "x");
    const result = toggleItem(s, "zzzz");
    expect(result).toBeNull();
    expect(s.items[0]?.done).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test test/examples/todo/core.test.ts`
Expected: FAIL — `toggleItem` not exported.

- [ ] **Step 3: Implement toggleItem**

Append to `examples/todo/core.ts`:

```ts
export function toggleItem(state: TodoState, id: string): TodoItem | null {
  const item = state.items.find((i) => i.id === id);
  if (!item) return null;
  item.done = !item.done;
  return item;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `bun test test/examples/todo/core.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/todo/core.ts test/examples/todo/core.test.ts
git commit -m "examples/todo: core toggleItem (PRI-1604)"
```

---

## Task 5: core.ts — deleteItem

**Files:**
- Modify: `examples/todo/core.ts`
- Modify: `test/examples/todo/core.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `test/examples/todo/core.test.ts`:

```ts
import { deleteItem } from "../../../examples/todo/core";

describe("deleteItem", () => {
  test("removes the named item and returns true", () => {
    const s: TodoState = { items: [], filter: "all" };
    const a = addItem(s, "a");
    const b = addItem(s, "b");
    const c = addItem(s, "c");
    expect(deleteItem(s, b.id)).toBe(true);
    expect(s.items.map((i) => i.text)).toEqual(["a", "c"]);
    expect(s.items.map((i) => i.id)).toEqual([a.id, c.id]);
  });

  test("returns false for unknown id, no mutation", () => {
    const s: TodoState = { items: [], filter: "all" };
    addItem(s, "x");
    expect(deleteItem(s, "zzzz")).toBe(false);
    expect(s.items.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test test/examples/todo/core.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement deleteItem**

Append to `examples/todo/core.ts`:

```ts
export function deleteItem(state: TodoState, id: string): boolean {
  const before = state.items.length;
  state.items = state.items.filter((i) => i.id !== id);
  return state.items.length < before;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `bun test test/examples/todo/core.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/todo/core.ts test/examples/todo/core.test.ts
git commit -m "examples/todo: core deleteItem (PRI-1604)"
```

---

## Task 6: core.ts — setFilter, visibleItems, activeCount

**Files:**
- Modify: `examples/todo/core.ts`
- Modify: `test/examples/todo/core.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `test/examples/todo/core.test.ts`:

```ts
import { setFilter, visibleItems, activeCount } from "../../../examples/todo/core";

describe("setFilter / visibleItems", () => {
  function seed(): TodoState {
    const s: TodoState = { items: [], filter: "all" };
    addItem(s, "a");
    const b = addItem(s, "b");
    addItem(s, "c");
    toggleItem(s, b.id);
    return s;
  }

  test("filter=all shows every item", () => {
    const s = seed();
    setFilter(s, "all");
    expect(visibleItems(s).map((i) => i.text)).toEqual(["a", "b", "c"]);
  });

  test("filter=active shows only undone items", () => {
    const s = seed();
    setFilter(s, "active");
    expect(visibleItems(s).map((i) => i.text)).toEqual(["a", "c"]);
  });

  test("filter=completed shows only done items", () => {
    const s = seed();
    setFilter(s, "completed");
    expect(visibleItems(s).map((i) => i.text)).toEqual(["b"]);
  });

  test("setFilter mutates state.filter", () => {
    const s = seed();
    setFilter(s, "completed");
    expect(s.filter).toBe("completed");
  });
});

describe("activeCount", () => {
  test("counts items where done=false, ignoring filter", () => {
    const s: TodoState = { items: [], filter: "completed" };
    addItem(s, "a");
    const b = addItem(s, "b");
    addItem(s, "c");
    toggleItem(s, b.id);
    expect(activeCount(s)).toBe(2);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test test/examples/todo/core.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement setFilter, visibleItems, activeCount**

Append to `examples/todo/core.ts`:

```ts
export function setFilter(state: TodoState, filter: Filter): void {
  state.filter = filter;
}

export function visibleItems(state: TodoState): TodoItem[] {
  switch (state.filter) {
    case "all":
      return state.items;
    case "active":
      return state.items.filter((i) => !i.done);
    case "completed":
      return state.items.filter((i) => i.done);
  }
}

export function activeCount(state: TodoState): number {
  return state.items.filter((i) => !i.done).length;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `bun test test/examples/todo/core.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/todo/core.ts test/examples/todo/core.test.ts
git commit -m "examples/todo: core setFilter + visibleItems + activeCount (PRI-1604)"
```

---

## Task 7: core.ts — clearCompleted

**Files:**
- Modify: `examples/todo/core.ts`
- Modify: `test/examples/todo/core.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `test/examples/todo/core.test.ts`:

```ts
import { clearCompleted } from "../../../examples/todo/core";

describe("clearCompleted", () => {
  test("removes all done items and returns the count removed", () => {
    const s: TodoState = { items: [], filter: "all" };
    addItem(s, "a");
    const b = addItem(s, "b");
    addItem(s, "c");
    const d = addItem(s, "d");
    toggleItem(s, b.id);
    toggleItem(s, d.id);
    expect(clearCompleted(s)).toBe(2);
    expect(s.items.map((i) => i.text)).toEqual(["a", "c"]);
  });

  test("removes nothing when no items are done", () => {
    const s: TodoState = { items: [], filter: "all" };
    addItem(s, "a");
    addItem(s, "b");
    expect(clearCompleted(s)).toBe(0);
    expect(s.items.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test test/examples/todo/core.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement clearCompleted**

Append to `examples/todo/core.ts`:

```ts
export function clearCompleted(state: TodoState): number {
  const before = state.items.length;
  state.items = state.items.filter((i) => !i.done);
  return before - state.items.length;
}
```

- [ ] **Step 4: Run to confirm pass and the whole suite is green**

Run: `bun test test/examples/todo/core.test.ts`
Expected: PASS — all groups.

- [ ] **Step 5: Commit**

```bash
git add examples/todo/core.ts test/examples/todo/core.test.ts
git commit -m "examples/todo: core clearCompleted (PRI-1604)"
```

---

## Task 8: cli.ts — argv dispatch and output formatting

**Files:**
- Create: `examples/todo/cli.ts`
- Create: `test/examples/todo/cli.test.ts`

- [ ] **Step 1: Write the failing test for CLI output shape**

Content for `test/examples/todo/cli.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "bun";

const CLI = "examples/todo/cli.ts";
let tmp: string;
let stateFile: string;

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const res = spawnSync(["bun", "run", CLI, ...args], {
    env: { ...process.env, TODO_STATE_FILE: stateFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: new TextDecoder().decode(res.stdout),
    stderr: new TextDecoder().decode(res.stderr),
    exitCode: res.exitCode ?? -1,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "todo-cli-"));
  stateFile = join(tmp, "state.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("cli", () => {
  test("add prints a row with an id and unchecked box", () => {
    const r = run(["add", "buy milk"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^[a-km-np-z2-9]{4}  \[ \] buy milk$/m);
  });

  test("list prints items with the always-on Filter footer", () => {
    run(["add", "first"]);
    run(["add", "second"]);
    const r = run(["list"]);
    expect(r.stdout).toContain("[ ] first");
    expect(r.stdout).toContain("[ ] second");
    expect(r.stdout).toMatch(/Filter: all — 2 items left$/m);
  });

  test("footer uses singular `item` for count of 1", () => {
    run(["add", "only one"]);
    const r = run(["list"]);
    expect(r.stdout).toMatch(/Filter: all — 1 item left$/m);
  });

  test("toggle flips done; the row prints [x]", () => {
    const added = run(["add", "x"]);
    const id = added.stdout.trim().split(/\s+/)[0]!;
    run(["toggle", id]);
    const r = run(["list"]);
    expect(r.stdout).toMatch(new RegExp(`${id}  \\[x\\] x`));
  });

  test("rm removes the named item", () => {
    const added = run(["add", "x"]);
    const id = added.stdout.trim().split(/\s+/)[0]!;
    const rm = run(["rm", id]);
    expect(rm.exitCode).toBe(0);
    const r = run(["list"]);
    expect(r.stdout).not.toContain(id);
    expect(r.stdout).toMatch(/0 items left$/m);
  });

  test("filter sets state.filter and re-prints the list", () => {
    run(["add", "a"]);
    const b = run(["add", "b"]);
    const bId = b.stdout.trim().split(/\s+/)[0]!;
    run(["toggle", bId]);
    const r = run(["filter", "active"]);
    expect(r.stdout).toMatch(/Filter: active — 1 item left \(showing 1 of 2\)/);
    expect(r.stdout).toContain("[ ] a");
    expect(r.stdout).not.toContain("[x] b");
  });

  test("clear-completed removes done items", () => {
    run(["add", "a"]);
    const b = run(["add", "b"]);
    const bId = b.stdout.trim().split(/\s+/)[0]!;
    run(["toggle", bId]);
    const r = run(["clear-completed"]);
    expect(r.exitCode).toBe(0);
    const lst = run(["list"]);
    expect(lst.stdout).toContain("[ ] a");
    expect(lst.stdout).not.toContain("b");
  });

  test("bare invocation is alias for list", () => {
    run(["add", "x"]);
    const r = run([]);
    expect(r.stdout).toContain("[ ] x");
    expect(r.stdout).toMatch(/Filter: all — 1 item left$/m);
  });

  test("unknown command prints usage to stderr and exits non-zero", () => {
    const r = run(["bogus"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("usage");
  });

  test("list --all ignores filter", () => {
    run(["add", "a"]);
    const b = run(["add", "b"]);
    const bId = b.stdout.trim().split(/\s+/)[0]!;
    run(["toggle", bId]);
    run(["filter", "completed"]);
    const r = run(["list", "--all"]);
    expect(r.stdout).toContain("[ ] a");
    expect(r.stdout).toContain("[x] b");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test test/examples/todo/cli.test.ts`
Expected: FAIL — `examples/todo/cli.ts` does not exist.

- [ ] **Step 3: Implement cli.ts**

Content for `examples/todo/cli.ts`:

```ts
#!/usr/bin/env bun
// Single-shot CLI frontend for the TODO fixture. Each invocation:
// load state, mutate, save, exit. Output format is stable and
// stdout-parseable — see examples/todo/README.md and the spec at
// docs/superpowers/specs/2026-05-14-todo-fixture-design.md.

import {
  loadState,
  saveState,
  addItem,
  toggleItem,
  deleteItem,
  setFilter,
  visibleItems,
  activeCount,
  clearCompleted,
  type Filter,
  type TodoItem,
  type TodoState,
} from "./core";

function formatRow(item: TodoItem): string {
  const box = item.done ? "[x]" : "[ ]";
  return `${item.id}  ${box} ${item.text}`;
}

function formatFooter(state: TodoState): string {
  const active = activeCount(state);
  const left = `${active} ${active === 1 ? "item" : "items"} left`;
  if (state.filter === "all") {
    return `Filter: all — ${left}`;
  }
  const shown = visibleItems(state).length;
  const total = state.items.length;
  return `Filter: ${state.filter} — ${left} (showing ${shown} of ${total})`;
}

function printList(state: TodoState, opts: { all?: boolean } = {}): void {
  const rows = opts.all ? state.items : visibleItems(state);
  for (const item of rows) {
    console.log(formatRow(item));
  }
  console.log(formatFooter(state));
}

function usage(): string {
  return [
    "usage: todo <command> [args]",
    "",
    "commands:",
    '  add "<text>"                       Add a new item.',
    "  list [--all]                       List visible items (or all).",
    "  toggle <id>                        Toggle the item with that id.",
    "  rm <id>                            Remove the item.",
    "  filter <all|active|completed>      Set filter and print list.",
    "  clear-completed                    Remove all done items.",
    "  (no args)                          Alias for `list`.",
  ].join("\n");
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const state = loadState();

  if (cmd === undefined || cmd === "list") {
    const all = rest.includes("--all");
    printList(state, { all });
    return 0;
  }

  if (cmd === "add") {
    const text = rest.join(" ");
    if (!text) {
      console.error("add: missing text");
      return 2;
    }
    const item = addItem(state, text);
    saveState(state);
    console.log(formatRow(item));
    return 0;
  }

  if (cmd === "toggle") {
    const id = rest[0];
    if (!id) {
      console.error("toggle: missing id");
      return 2;
    }
    const item = toggleItem(state, id);
    if (!item) {
      console.error(`toggle: no item with id ${id}`);
      return 1;
    }
    saveState(state);
    console.log(formatRow(item));
    return 0;
  }

  if (cmd === "rm") {
    const id = rest[0];
    if (!id) {
      console.error("rm: missing id");
      return 2;
    }
    const ok = deleteItem(state, id);
    if (!ok) {
      console.error(`rm: no item with id ${id}`);
      return 1;
    }
    saveState(state);
    return 0;
  }

  if (cmd === "filter") {
    const f = rest[0] as Filter | undefined;
    if (f !== "all" && f !== "active" && f !== "completed") {
      console.error("filter: expected one of all|active|completed");
      return 2;
    }
    setFilter(state, f);
    saveState(state);
    printList(state);
    return 0;
  }

  if (cmd === "clear-completed") {
    clearCompleted(state);
    saveState(state);
    return 0;
  }

  console.error(`unknown command: ${cmd}\n\n${usage()}`);
  return 2;
}

process.exit(main(process.argv.slice(2)));
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `bun test test/examples/todo/cli.test.ts`
Expected: PASS — all tests.

- [ ] **Step 5: Sanity-check the typecheck still passes for the whole project**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/todo/cli.ts test/examples/todo/cli.test.ts
git commit -m "examples/todo: CLI frontend (argv dispatch + tested output shape) (PRI-1604)"
```

---

## Task 9: Manual CLI smoke test

- [ ] **Step 1: Drive the CLI by hand against a tempdir**

Run:

```bash
export TODO_STATE_FILE=/tmp/todo-smoke.json
rm -f "$TODO_STATE_FILE"
bun run examples/todo/cli.ts add "buy milk"
bun run examples/todo/cli.ts add "walk dog"
bun run examples/todo/cli.ts add "call mom"
bun run examples/todo/cli.ts list
# expect 3 rows + `Filter: all — 3 items left`
ID=$(bun run examples/todo/cli.ts add "extra" | awk '{print $1}')
bun run examples/todo/cli.ts toggle "$ID"
bun run examples/todo/cli.ts list
# expect `[x] extra` line
bun run examples/todo/cli.ts filter active
# expect `Filter: active — ...` and `[x] extra` not visible
bun run examples/todo/cli.ts clear-completed
bun run examples/todo/cli.ts list --all
# expect no `extra` row anywhere
unset TODO_STATE_FILE
rm -f /tmp/todo-smoke.json
```

Each step should look right by eye. If any output is off, fix the CLI and add a regression test before proceeding.

- [ ] **Step 2: No commit (smoke test only)**

---

## Task 10: Story cards (01–08)

**Files:**
- Create: `examples/todo/.gauntlet/stories/01-add-one.md`
- Create: `examples/todo/.gauntlet/stories/02-add-three.md`
- Create: `examples/todo/.gauntlet/stories/03-toggle-one.md`
- Create: `examples/todo/.gauntlet/stories/04-toggle-selectively.md`
- Create: `examples/todo/.gauntlet/stories/05-delete-one.md`
- Create: `examples/todo/.gauntlet/stories/06-filter-active.md`
- Create: `examples/todo/.gauntlet/stories/07-clear-completed.md`
- Create: `examples/todo/.gauntlet/stories/08-count-readback.md`

- [ ] **Step 1: Create all eight story files (content matches the spec verbatim)**

`01-add-one.md`:

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
- The "items left" readout shows `1 item left` (starting from
  the empty fixture state, one item was added)
```

`02-add-three.md`:

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
- The "items left" readout shows `3 items left` (starting from
  the empty fixture state)
```

`03-toggle-one.md`:

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

`04-toggle-selectively.md`:

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

`05-delete-one.md`:

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

`06-filter-active.md`:

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
- The app's readout names "active" as the currently selected
  view (the items are filtered, not deleted — switching back
  to the full view would bring them back)
```

`07-clear-completed.md`:

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

`08-count-readback.md`:

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
- The reported count cites the "items left" readout shown by
  the app, not an inferred count
```

- [ ] **Step 2: Commit all eight cards together**

```bash
git add examples/todo/.gauntlet/stories/
git commit -m "examples/todo: eight portable story cards (PRI-1604)"
```

---

## Task 11: Run all eight cards against the CLI adapter

This is the first end-to-end check that the fixture works. The CLI is the cheapest surface to debug, so we drive the full card matrix here before touching TUI/Web.

**The CLI-adapter wrinkle.** Gauntlet's CLI adapter spawns `sh -c "<target>"` and connects the agent to that process's stdin/stdout. The cards talk about running "the todo app" — so the agent needs `todo` (or some equivalent) to be a callable command. The fixture doesn't ship a binary on `$PATH`; instead, the target shell-command sets up a shell with a `todo` function in scope and `cd`s the agent into an isolated scratch dir.

Create a small launcher script the target can invoke:

`examples/todo/run-cli-shell.sh`:

```bash
#!/usr/bin/env bash
# Launcher for the Gauntlet CLI adapter. Sets up an isolated
# scratch dir, drops a `todo` shim into a private bin dir on
# PATH, then exec's an interactive bash so the agent can issue
# todo commands. State lives under the scratch dir.
#
# Why a PATH shim and not `export -f todo`: bash exported
# functions only survive bash-to-bash exec, and Gauntlet's CLI
# adapter invokes targets via `sh -c`, which on Linux is usually
# dash. A real shim script on PATH survives any shell exec.
set -e
SCRATCH="$(mktemp -d -t todo-card-XXXXXX)"
export TODO_STATE_FILE="$SCRATCH/state.json"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[[ -d "$REPO_ROOT/examples/todo" ]] || {
  echo "launcher: REPO_ROOT wrong: $REPO_ROOT" >&2; exit 1;
}
mkdir -p "$SCRATCH/bin"
cat >"$SCRATCH/bin/todo" <<EOF
#!/usr/bin/env bash
exec bun run "$REPO_ROOT/examples/todo/cli.ts" "\$@"
EOF
chmod +x "$SCRATCH/bin/todo"
export PATH="$SCRATCH/bin:$PATH"
export PS1="todo$ "
cd "$SCRATCH"
echo "todo fixture ready. state: $TODO_STATE_FILE"
# -i forces interactive mode (prompts emit on stdout, line editing on);
# --norc --noprofile keeps the env clean for reproducibility.
exec bash --norc --noprofile -i
```

- [ ] **Step 1: Add the launcher and make it executable**

```bash
chmod +x examples/todo/run-cli-shell.sh
git add examples/todo/run-cli-shell.sh
git commit -m "examples/todo: CLI-adapter launcher (PRI-1604)"
```

- [ ] **Step 2: Run one card first — card 01 — to verify wiring**

Run:

```bash
gauntlet run examples/todo/.gauntlet/stories/01-add-one.md \
  --adapter cli \
  --target "$(pwd)/examples/todo/run-cli-shell.sh" \
  --max-time 3m
```

Expected: result lands under `examples/todo/.gauntlet/results/...`. Open the newest one and check:
- Auditor verdict (pass/fail).
- Transcript — did the agent invoke `todo add` etc.?
- The `state.json` under whichever scratch dir the launcher created.

- [ ] **Step 3: If card 01 passes, run the remaining seven**

```bash
for story in examples/todo/.gauntlet/stories/0{2,3,4,5,6,7,8}-*.md; do
  gauntlet run "$story" \
    --adapter cli \
    --target "$(pwd)/examples/todo/run-cli-shell.sh" \
    --max-time 3m
done
```

Investigate any failures. Common shapes:
- CLI output diverges from card expectation → fix `cli.ts` (and add a regression test in `cli.test.ts`).
- Card AC unsatisfiable or unclear → revise the card, re-reading the `writing-gauntlet-stories` skill.
- `core.ts` resolving state path wrong → check `resolveStatePath` against what the launcher exports.

- [ ] **Step 4: No commit until all CLI cards pass** (other than fixture/card fixes made along the way)

---

## Task 12: TUI — add Ink dependency and basic render

**Files:**
- Modify: `package.json`
- Create: `examples/todo/tui.tsx`
- Modify: `tsconfig.json` (only if it does not already allow JSX)

- [ ] **Step 1: Add Ink and React dependencies**

Run:

```bash
bun add ink react
bun add -d @types/react
```

- [ ] **Step 2: Confirm tsconfig allows JSX**

Run: `cat tsconfig.json`

If `jsx` is not set to `"react-jsx"` (or compatible), add it:

```bash
# Verify before editing — only modify if needed
grep '"jsx"' tsconfig.json || echo "tsconfig.json needs jsx config"
```

If needed, edit `tsconfig.json` to set `"jsx": "react-jsx"` under `compilerOptions`.

- [ ] **Step 3: Write a minimal Ink-based tui.tsx that renders state and exits on q**

Content for `examples/todo/tui.tsx`:

```tsx
// Long-running TUI frontend for the TODO fixture. Ink-based.
// Reads state at startup, mutates in-memory, writes after every
// change. Keybinds documented in the spec and shown in the footer.

import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import {
  loadState,
  saveState,
  addItem,
  toggleItem,
  deleteItem,
  setFilter,
  visibleItems,
  activeCount,
  clearCompleted,
  type TodoState,
  type Filter,
} from "./core";

interface Props {
  initial: TodoState;
}

function App({ initial }: Props) {
  const [state, setState] = useState<TodoState>(initial);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<"normal" | "input">("normal");
  const [draft, setDraft] = useState("");
  const { exit } = useApp();

  const items = visibleItems(state);
  const safeCursor = Math.max(0, Math.min(cursor, items.length - 1));

  function persist(next: TodoState) {
    // core.ts ops mutate state in place. Save first, then push a
    // shallow clone into React so the render cycle picks up the
    // change. Two-level clone is sufficient because items are
    // replaced (not mutated) on filter/clear/delete, and `done`
    // is the only per-item field that flips — Ink re-renders on
    // setState regardless of identity for primitive fields.
    saveState(next);
    setState({ ...next, items: [...next.items] });
  }

  useInput((input, key) => {
    if (mode === "input") {
      if (key.return) {
        if (draft.trim()) {
          addItem(state, draft.trim());
          persist(state);
        }
        setDraft("");
        setMode("normal");
        return;
      }
      if (key.escape) {
        setDraft("");
        setMode("normal");
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((d) => d.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setDraft((d) => d + input);
      }
      return;
    }

    // normal mode
    if (input === "q") {
      exit();
      return;
    }
    if (input === "i") {
      setMode("input");
      return;
    }
    if (input === "j" || key.downArrow) {
      setCursor((c) => Math.min(items.length - 1, c + 1));
      return;
    }
    if (input === "k" || key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (input === " " || key.return) {
      const target = items[safeCursor];
      if (target) {
        toggleItem(state, target.id);
        persist(state);
      }
      return;
    }
    if (input === "d") {
      const target = items[safeCursor];
      if (target) {
        deleteItem(state, target.id);
        persist(state);
        setCursor((c) => Math.max(0, Math.min(c, items.length - 2)));
      }
      return;
    }
    if (input === "1" || input === "2" || input === "3") {
      const f: Filter = input === "1" ? "all" : input === "2" ? "active" : "completed";
      setFilter(state, f);
      persist(state);
      setCursor(0);
      return;
    }
    if (input === "c") {
      clearCompleted(state);
      persist(state);
      setCursor(0);
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <Text>
        TODO — {activeCount(state)} items left — filter: {state.filter}
      </Text>
      {mode === "input" ? (
        <Text>{`> ${draft}`}</Text>
      ) : null}
      {items.map((item, idx) => {
        const box = item.done ? "[x]" : "[ ]";
        const selected = idx === safeCursor && mode === "normal";
        return (
          <Text key={item.id} inverse={selected}>
            {box} {item.text}
          </Text>
        );
      })}
      <Text dimColor>
        [i] add  [j/k] move  [space] toggle  [d] delete  [1/2/3] filter  [c] clear-completed  [q] quit
      </Text>
    </Box>
  );
}

const initial = loadState();
render(<App initial={initial} />);
```

- [ ] **Step 4: Confirm typecheck passes**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock tsconfig.json examples/todo/tui.tsx
git commit -m "examples/todo: TUI frontend via Ink (PRI-1604)"
```

---

## Task 13: Manual TUI smoke test

- [ ] **Step 1: Drive the TUI by hand against a tempdir**

Run:

```bash
export TODO_STATE_FILE=/tmp/todo-tui-smoke.json
rm -f "$TODO_STATE_FILE"
bun run examples/todo/tui.tsx
```

Manually verify each operation:
1. Press `i`, type "first", press Enter. Item appears.
2. Press `i`, type "second", Enter. Two items.
3. Press `i`, type "third", Enter. Three items.
4. `j` moves cursor down (reverse-video highlight moves).
5. `k` moves it back up.
6. With cursor on row 2, press Space. That item gets `[x]`.
7. Press `2`. View filters to active (only rows 1 and 3 visible).
8. Press `1`. All three visible again.
9. With cursor on row 1, press `d`. Row removed.
10. Press `c`. The `[x]` row removed.
11. Press `q`. Exits cleanly to shell prompt.

Then:

```bash
cat "$TODO_STATE_FILE"
# verify it matches what's left on screen
unset TODO_STATE_FILE
rm -f /tmp/todo-tui-smoke.json
```

- [ ] **Step 2: No commit (smoke test only)**

If anything's off — wrong rendering, key bound wrong, cursor stays off-screen — fix it and re-test before moving on.

---

## Task 14: Run all eight cards against the TUI adapter

The TUI adapter spawns the target as a TTY-bearing process (tmux-backed). The target is the bun command that runs the TUI directly. State isolation is via `TODO_STATE_FILE` exported in the gauntlet invocation environment, or via a small launcher shell similar to the CLI one. Use a launcher for consistency.

`examples/todo/run-tui.sh`:

```bash
#!/usr/bin/env bash
# Launcher for the Gauntlet TUI adapter. Isolated scratch dir +
# state file, then exec the TUI directly.
set -e
SCRATCH="$(mktemp -d -t todo-card-XXXXXX)"
export TODO_STATE_FILE="$SCRATCH/state.json"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[[ -d "$REPO_ROOT/examples/todo" ]] || {
  echo "launcher: REPO_ROOT wrong: $REPO_ROOT" >&2; exit 1;
}
exec bun run "$REPO_ROOT/examples/todo/tui.tsx"
```

- [ ] **Step 1: Add the launcher**

```bash
chmod +x examples/todo/run-tui.sh
git add examples/todo/run-tui.sh
git commit -m "examples/todo: TUI-adapter launcher (PRI-1604)"
```

- [ ] **Step 2: Run card 01 against the TUI adapter**

```bash
gauntlet run examples/todo/.gauntlet/stories/01-add-one.md \
  --adapter tui \
  --target "$(pwd)/examples/todo/run-tui.sh" \
  --max-time 5m
```

Expected: result lands under `.gauntlet/results/`, auditor passes.

- [ ] **Step 3: If card 01 passes, run the remaining seven**

```bash
for story in examples/todo/.gauntlet/stories/0{2,3,4,5,6,7,8}-*.md; do
  gauntlet run "$story" \
    --adapter tui \
    --target "$(pwd)/examples/todo/run-tui.sh" \
    --max-time 5m
done
```

Investigate any failures. TUI-specific gotchas to watch for:
- Long output exceeding viewport (we explicitly deferred coverage to v2, but if a card we *did* write trips this, the bug is real).
- ANSI reverse-video for cursor row not being read by the adapter's capture-pane logic — known historical issue (see project memories on tmux/xterm scrolling).

- [ ] **Step 4: No commit until all TUI cards pass** (other than fixture/card fixes made along the way)

---

## Task 15: Web — server and index.html

**Files:**
- Create: `examples/todo/web/server.ts`
- Create: `examples/todo/web/public/index.html`

- [ ] **Step 1: Implement the Bun HTTP server**

Content for `examples/todo/web/server.ts`:

```ts
// HTTP server frontend for the TODO fixture. Long-running.
// In-memory state, persists via core.ts (which honors
// $TODO_STATE_FILE for harness-driven isolation).
//
// Don't use this as a starter. No auth, no CSRF, no rate limit.
// The point is a deterministic target for the Web adapter.

import { resolve } from "path";
import {
  loadState,
  saveState,
  addItem,
  toggleItem,
  deleteItem,
  setFilter,
  clearCompleted,
  type Filter,
} from "../core";

const PORT = Number(process.env.TODO_WEB_PORT ?? 7891);
const PUBLIC_DIR = resolve(import.meta.dir, "public");

let state = loadState();

function persist() {
  saveState(state);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (method === "GET" && path === "/api/state") {
    return jsonResponse(state);
  }
  if (method === "POST" && path === "/api/add") {
    const body = (await req.json()) as { text?: string };
    if (!body.text || typeof body.text !== "string") {
      return jsonResponse({ error: "text required" }, 400);
    }
    addItem(state, body.text);
    persist();
    return jsonResponse(state);
  }
  if (method === "POST" && path === "/api/toggle") {
    const body = (await req.json()) as { id?: string };
    if (!body.id) return jsonResponse({ error: "id required" }, 400);
    toggleItem(state, body.id);
    persist();
    return jsonResponse(state);
  }
  if (method === "POST" && path === "/api/delete") {
    const body = (await req.json()) as { id?: string };
    if (!body.id) return jsonResponse({ error: "id required" }, 400);
    deleteItem(state, body.id);
    persist();
    return jsonResponse(state);
  }
  if (method === "POST" && path === "/api/filter") {
    const body = (await req.json()) as { filter?: Filter };
    if (
      body.filter !== "all" &&
      body.filter !== "active" &&
      body.filter !== "completed"
    ) {
      return jsonResponse({ error: "filter must be all|active|completed" }, 400);
    }
    setFilter(state, body.filter);
    persist();
    return jsonResponse(state);
  }
  if (method === "POST" && path === "/api/clear-completed") {
    clearCompleted(state);
    persist();
    return jsonResponse(state);
  }
  return jsonResponse({ error: "not found" }, 404);
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(req, url);
    }
    // Serve index.html for "/" and anything not under /api/.
    const reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const resolved = resolve(PUBLIC_DIR, "." + reqPath);
    // Guard against path traversal — keep resolved path inside PUBLIC_DIR.
    if (!resolved.startsWith(PUBLIC_DIR + "/") && resolved !== PUBLIC_DIR) {
      return new Response("not found", { status: 404 });
    }
    const file = Bun.file(resolved);
    if (await file.exists()) {
      return new Response(file);
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`TODO fixture web server listening on http://localhost:${PORT}`);
```

- [ ] **Step 2: Implement the single-page UI**

Content for `examples/todo/web/public/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>TODO</title>
  <style>
    body {
      font-family: system-ui, sans-serif;
      max-width: 480px;
      margin: 2rem auto;
      padding: 0 1rem;
      color: #222;
    }
    h1 { font-weight: 300; font-size: 3rem; text-align: center; margin: 0 0 1rem; color: #c44; }
    .new-item input {
      width: 100%;
      font-size: 1.5rem;
      padding: 0.5rem 0.75rem;
      box-sizing: border-box;
      border: 1px solid #ccc;
    }
    ul { list-style: none; padding: 0; margin: 1rem 0; border-top: 1px solid #eee; }
    li {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem;
      border-bottom: 1px solid #eee;
      font-size: 1.25rem;
    }
    li.done .text { text-decoration: line-through; color: #999; }
    .text { flex: 1; }
    .delete {
      background: none;
      border: none;
      color: #c44;
      font-size: 1.25rem;
      cursor: pointer;
      padding: 0 0.25rem;
    }
    footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.9rem;
      color: #555;
    }
    .filters { display: flex; gap: 0.25rem; }
    .filters button {
      background: white;
      border: 1px solid transparent;
      padding: 0.25rem 0.5rem;
      cursor: pointer;
    }
    .filters button.selected {
      background: #fde;
      border-color: #c44;
    }
    .clear {
      background: none;
      border: none;
      cursor: pointer;
      color: #555;
    }
    .clear:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>TODO</h1>
  <form class="new-item" id="add-form">
    <input id="new-text" placeholder="What needs doing?" autofocus />
  </form>
  <ul id="list"></ul>
  <footer>
    <span id="count">0 items left</span>
    <div class="filters">
      <button data-filter="all">All</button>
      <button data-filter="active">Active</button>
      <button data-filter="completed">Completed</button>
    </div>
    <button class="clear" id="clear">Clear completed</button>
  </footer>

  <script>
    async function api(path, body) {
      const opts = body
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : { method: "GET" };
      const res = await fetch(path, opts);
      return res.json();
    }

    let state = { items: [], filter: "all" };

    function visible() {
      if (state.filter === "all") return state.items;
      if (state.filter === "active") return state.items.filter((i) => !i.done);
      return state.items.filter((i) => i.done);
    }

    function activeCount() {
      return state.items.filter((i) => !i.done).length;
    }

    function render() {
      const list = document.getElementById("list");
      list.innerHTML = "";
      for (const item of visible()) {
        const li = document.createElement("li");
        if (item.done) li.classList.add("done");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = item.done;
        box.addEventListener("change", async () => {
          state = await api("/api/toggle", { id: item.id });
          render();
        });
        const text = document.createElement("span");
        text.className = "text";
        text.textContent = item.text;
        const del = document.createElement("button");
        del.className = "delete";
        del.textContent = "✕";
        del.addEventListener("click", async () => {
          state = await api("/api/delete", { id: item.id });
          render();
        });
        li.appendChild(box);
        li.appendChild(text);
        li.appendChild(del);
        list.appendChild(li);
      }
      document.getElementById("count").textContent = `${activeCount()} items left`;
      for (const btn of document.querySelectorAll(".filters button")) {
        btn.classList.toggle("selected", btn.dataset.filter === state.filter);
      }
    }

    document.getElementById("add-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("new-text");
      const text = input.value.trim();
      if (!text) return;
      state = await api("/api/add", { text });
      input.value = "";
      render();
    });

    for (const btn of document.querySelectorAll(".filters button")) {
      btn.addEventListener("click", async () => {
        state = await api("/api/filter", { filter: btn.dataset.filter });
        render();
      });
    }

    document.getElementById("clear").addEventListener("click", async () => {
      state = await api("/api/clear-completed");
      render();
    });

    api("/api/state").then((s) => { state = s; render(); });
  </script>
</body>
</html>
```

- [ ] **Step 3: Confirm typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add examples/todo/web/
git commit -m "examples/todo: Web frontend (Bun.serve + vanilla HTML/JS) (PRI-1604)"
```

---

## Task 16: Manual Web smoke test

- [ ] **Step 1: Drive the Web app by hand**

Run:

```bash
export TODO_STATE_FILE=/tmp/todo-web-smoke.json
rm -f "$TODO_STATE_FILE"
bun run examples/todo/web/server.ts &
SERVER_PID=$!
sleep 1
open http://localhost:7891  # or curl + manual browser check
```

In the browser, verify:
1. Empty list initially.
2. Type "first" in the input, Enter — row appears with empty checkbox.
3. Add "second" and "third".
4. Check the box on "second" — row gets strikethrough.
5. Click `Active` filter — only "first" and "third" visible. `Active` button shows the selected style.
6. Click `Completed` — only "second" visible.
7. Click `All` — all three visible.
8. Click ✕ on "first" — row gone.
9. Click `Clear completed` — "second" gone, only "third" remains.
10. Count footer reads "1 item left".

Then:

```bash
kill $SERVER_PID
cat "$TODO_STATE_FILE"
unset TODO_STATE_FILE
rm -f /tmp/todo-web-smoke.json
```

- [ ] **Step 2: No commit (smoke test only)**

---

## Task 17: Run all eight cards against the Web adapter

The Web adapter (CDP-based) needs the server running before the run. Each card invocation needs a fresh state, so the server should be restarted between runs (it loads state from disk at startup; a fresh `$TODO_STATE_FILE` is enough). A small launcher handles both: pick a fresh tempfile and start the server in the foreground.

`examples/todo/run-web.sh`:

```bash
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
```

- [ ] **Step 1: Add the launcher**

```bash
chmod +x examples/todo/run-web.sh
git add examples/todo/run-web.sh
git commit -m "examples/todo: Web-adapter launcher (PRI-1604)"
```

- [ ] **Step 2: Start the server in one terminal, run card 01 in another**

Terminal A:

```bash
./examples/todo/run-web.sh
```

Terminal B:

```bash
gauntlet run examples/todo/.gauntlet/stories/01-add-one.md \
  --adapter web \
  --target "http://localhost:7891" \
  --max-time 5m
```

Expected: result lands under `.gauntlet/results/`, auditor passes.

- [ ] **Step 3: Restart server, run card 02. Repeat for 03–08.**

A short shell loop that restarts the server between cards (use `pkill -f web/server.ts` or kill via PID):

```bash
for story in examples/todo/.gauntlet/stories/0{2,3,4,5,6,7,8}-*.md; do
  ./examples/todo/run-web.sh &
  SERVER_PID=$!
  sleep 1
  gauntlet run "$story" \
    --adapter web \
    --target "http://localhost:7891" \
    --max-time 5m
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  sleep 1  # let the OS release :7891 before the next bind
done
```

Investigate any failures. Web-specific gotchas:
- Filter `<button>` selection style must be DOM-readable (background fill, not just bold) — per spec.
- `✕` delete button must be always-visible. If the adapter misses it, check the CSS isn't hiding it behind hover.
- Cookie/profile-dir leakage between runs is a known historical issue in `gauntlet serve` (resolved in PRI-1280); doesn't apply to one-shot `gauntlet run` invocations, but worth knowing.

- [ ] **Step 4: No commit until all Web cards pass** (other than fixture/card fixes made along the way)

---

## Task 18: Final verification — all 8 cards × 3 adapters

- [ ] **Step 1: Run the full matrix**

Run each of the eight cards against each adapter — 24 runs total. Record any flake.

- [ ] **Step 2: Verify the full project still passes**

Run: `bun run check`
Expected: typecheck + UI typecheck + UI build + tests all pass.

- [ ] **Step 3: Commit anything that changed during the verification pass (if anything)**

If card adjustments or CLI/TUI/Web tweaks were needed, commit them with a clear message tying back to which adapter run motivated the change.

---

## Task 19: Move PRI-1604 to In Review with a reflective comment

- [ ] **Step 1: Update Linear**

Per the `linear-ticket-lifecycle` skill: move `PRI-1604` to **In Review** (not a terminal state — Drew or another human reviewer closes it) and write a reflective comment covering what went smoothly, what was tricky, how it felt, and any risk flags worth noting.

Use the Linear MCP tools (`mcp__plugin_linear_linear__save_issue` to change state, `mcp__plugin_linear_linear__save_comment` to post the reflection).

- [ ] **Step 2: No commit (Linear-only step)**

---

## Self-review checklist

- **Spec coverage:** Every section of the spec maps to at least one task. Data model + state I/O = T2; addItem/toggle/delete/filter/clear-completed/activeCount/visibleItems = T3–T7; CLI surface = T8; TUI keybinds/render = T12; Web layout/API = T15; cards = T10; CLAUDE.md = T1; verdict via auditor = exercised in T11/T14/T17.
- **Placeholder scan:** No TBDs, no "TODO", no "implement later", no "similar to Task N", no "appropriate error handling". Each step has actual code or actual command output.
- **Type consistency:** `loadState/saveState/addItem/toggleItem/deleteItem/setFilter/visibleItems/activeCount/clearCompleted` — same names from `core.ts` (T2–T7) through `cli.ts` (T8) and `tui.tsx` (T12) and `web/server.ts` (T15). `Filter = "all" | "active" | "completed"` — consistent everywhere. `TodoItem.id` — 4-char alphabet `[a-km-np-z2-9]` — consistent in test regex (T3) and ID generator (T3).
- **Frequent commits:** Every task except smoke-test-only ones (T9, T13, T16) ends in a commit. Smoke tests are explicitly no-commit because they're verification.
- **Adapter-specific gotchas honored:**
  - Web filter UI uses `<button>`, never `<select>` (T15) — per the CDP trap memory.
  - Web ✕ button is always visible, no hover-to-reveal (T15) — per spec.
  - TUI normal-mode keybinds suppressed during input mode (T12) — per the corrected spec.
