import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { PrettyRenderer } from "../../../src/cli/stream/pretty";
import type { StreamEvent } from "../../../src/cli/stream/renderer";

function loadFixture(name: string): { events: StreamEvent[]; expected: string } {
  const jsonl = readFileSync(join(import.meta.dir, `fixtures/${name}.jsonl`), "utf8");
  const expected = readFileSync(join(import.meta.dir, `fixtures/${name}.pretty.txt`), "utf8");
  const events = jsonl.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { events, expected };
}

function collect(): { out: string; write: (s: string) => void } {
  const obj = { out: "", write(s: string) { obj.out += s; } };
  return obj;
}

describe("PrettyRenderer", () => {
  test("renders run_start and run_end panels (happy fixture, start/end only)", () => {
    const { events, expected } = loadFixture("happy");
    const startAndEnd = events.filter((e) => e.type === "run_start" || e.type === "run_end");

    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 100 });
    for (const e of startAndEnd) r.handle(e);
    r.close();

    expect(sink.out).toBe(expected);
  });
});
