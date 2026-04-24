import { describe, test, expect } from "bun:test";
import { resolveStreamOptions } from "../../../src/cli/stream/format";

describe("resolveStreamOptions", () => {
  test("defaults: TTY + no NO_COLOR → pretty + color", () => {
    const o = resolveStreamOptions({ isTTY: true, env: {}, silent: false, format: undefined, noColor: false, columns: 100 });
    expect(o).toEqual({ silent: false, format: "pretty", color: true, columns: 100 });
  });

  test("non-TTY → jsonl, no color", () => {
    const o = resolveStreamOptions({ isTTY: false, env: {}, silent: false, format: undefined, noColor: false, columns: 100 });
    expect(o.format).toBe("jsonl");
    expect(o.color).toBe(false);
  });

  test("NO_COLOR env disables color even on TTY", () => {
    const o = resolveStreamOptions({ isTTY: true, env: { NO_COLOR: "1" }, silent: false, format: undefined, noColor: false, columns: 100 });
    expect(o.color).toBe(false);
    expect(o.format).toBe("pretty"); // format unaffected
  });

  test("--no-color flag disables color even on TTY", () => {
    const o = resolveStreamOptions({ isTTY: true, env: {}, silent: false, format: undefined, noColor: true, columns: 100 });
    expect(o.color).toBe(false);
  });

  test("--format pretty forces pretty even when piped", () => {
    const o = resolveStreamOptions({ isTTY: false, env: {}, silent: false, format: "pretty", noColor: false, columns: 100 });
    expect(o.format).toBe("pretty");
    expect(o.color).toBe(false); // still no color off-TTY
  });

  test("--format jsonl forces jsonl even on TTY", () => {
    const o = resolveStreamOptions({ isTTY: true, env: {}, silent: false, format: "jsonl", noColor: false, columns: 100 });
    expect(o.format).toBe("jsonl");
  });

  test("--silent takes precedence over everything", () => {
    const o = resolveStreamOptions({ isTTY: true, env: {}, silent: true, format: "pretty", noColor: false, columns: 100 });
    expect(o.silent).toBe(true);
  });
});
