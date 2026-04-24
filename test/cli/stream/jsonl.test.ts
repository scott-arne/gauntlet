import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { JsonlRenderer } from "../../../src/cli/stream/jsonl";

function collect(): { out: string; write: (s: string) => void } {
  const obj = { out: "", write(s: string) { obj.out += s; } };
  return obj;
}

describe("JsonlRenderer", () => {
  test("writes each event as one JSON line verbatim", () => {
    const fixture = readFileSync(join(import.meta.dir, "fixtures/happy.jsonl"), "utf8");
    const events = fixture.split("\n").filter(Boolean).map((l) => JSON.parse(l));

    const sink = collect();
    const r = new JsonlRenderer(sink);
    for (const e of events) r.handle(e);
    r.close();

    const lines = sink.out.split("\n").filter(Boolean);
    expect(lines.length).toBe(events.length);
    for (let i = 0; i < events.length; i++) {
      expect(JSON.parse(lines[i])).toEqual(events[i]);
    }
  });
});
