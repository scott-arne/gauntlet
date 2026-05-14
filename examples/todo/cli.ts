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
