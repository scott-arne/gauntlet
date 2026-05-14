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
