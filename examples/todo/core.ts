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
