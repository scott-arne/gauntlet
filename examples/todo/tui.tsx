// Long-running TUI frontend for the TODO fixture. Ink-based.
// Reads state at startup, mutates in-memory, writes after every
// change. Keybinds documented in the spec and shown in the footer.

import React, { useState } from "react";
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
      {mode === "input" ? <Text>{`> ${draft}`}</Text> : null}
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
