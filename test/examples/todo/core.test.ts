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
