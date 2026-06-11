import { describe, test, expect } from "bun:test";
import { parseReportResult, salvageReportResult, validateToolArgs } from "../../src/agent/validators";
import type { ToolDefinition } from "../../src/models/provider";

describe("parseReportResult", () => {
  test("accepts a well-formed report with no observations", () => {
    const result = parseReportResult({
      status: "pass",
      summary: "All checks passed",
      reasoning: "Screenshot matched expectations",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("pass");
      expect(result.value.summary).toBe("All checks passed");
      expect(result.value.reasoning).toBe("Screenshot matched expectations");
      expect(result.value.observations).toEqual([]);
    }
  });

  test("accepts a well-formed report with observations", () => {
    const result = parseReportResult({
      status: "investigate",
      summary: "Saw something weird",
      reasoning: "Flaky element",
      observations: [
        { kind: "bug", description: "Button vanishes on hover" },
        { kind: "ux", description: "Low contrast" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.observations).toHaveLength(2);
      expect(result.value.observations[0]).toEqual({
        kind: "bug",
        description: "Button vanishes on hover",
      });
    }
  });

  test("rejects non-object args", () => {
    const r1 = parseReportResult("a string");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toContain("expected object");

    const r2 = parseReportResult(null);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain("expected object");

    const r3 = parseReportResult(["pass"]);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toContain("expected object");
  });

  test("rejects status that is not a string", () => {
    const result = parseReportResult({
      status: 1,
      summary: "x",
      reasoning: "y",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("status");
  });

  test("rejects status not in the enum", () => {
    const result = parseReportResult({
      status: "success",
      summary: "x",
      reasoning: "y",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("status");
      expect(result.reason).toContain("success");
    }
  });

  test("rejects non-string summary", () => {
    const result = parseReportResult({
      status: "pass",
      summary: { text: "x" },
      reasoning: "y",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("summary");
  });

  test("rejects non-string reasoning", () => {
    const result = parseReportResult({
      status: "pass",
      summary: "x",
      reasoning: 42,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("reasoning");
  });

  test("rejects observations that is not an array", () => {
    const result = parseReportResult({
      status: "pass",
      summary: "x",
      reasoning: "y",
      observations: "none",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("observations");
  });

  test("recovers observations passed as a JSON-encoded string", () => {
    // Sonnet 4.6 has been observed to double-encode observations. The data
    // is valid — we should accept it rather than discard a whole run.
    const result = parseReportResult({
      status: "pass",
      summary: "x",
      reasoning: "y",
      observations: JSON.stringify([
        { kind: "ux", description: "tight margins" },
        { kind: "bug", description: "off-by-one in pagination" },
      ]),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.observations).toHaveLength(2);
      expect(result.value.observations[0]).toEqual({
        kind: "ux",
        description: "tight margins",
      });
    }
  });

  test("rejects a JSON string that decodes to a non-array", () => {
    const result = parseReportResult({
      status: "pass",
      summary: "x",
      reasoning: "y",
      observations: JSON.stringify({ kind: "ux", description: "x" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("observations");
  });

  test("rejects observation with bad kind", () => {
    const result = parseReportResult({
      status: "pass",
      summary: "x",
      reasoning: "y",
      observations: [{ kind: "feature", description: "nice" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("observations[0].kind");
    }
  });

  test("rejects observation with missing description", () => {
    const result = parseReportResult({
      status: "pass",
      summary: "x",
      reasoning: "y",
      observations: [{ kind: "bug" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("observations[0].description");
    }
  });

  test("accepts null observations as 'none'", () => {
    const result = parseReportResult({
      status: "fail",
      summary: "x",
      reasoning: "y",
      observations: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.observations).toEqual([]);
  });
});

describe("salvageReportResult", () => {
  // Regression: PRI-2140. In sdd-go-fractals-pi-20260609T064827Z-be6e the
  // model reported a real pass, but observations[4].kind arrived as "ug"
  // (truncated "bug") and the whole verdict was discarded as investigate.
  // Salvage must keep the verdict and drop only the corrupt observation.
  test("keeps a valid verdict and drops the observation with a truncated kind enum (PRI-2140)", () => {
    const result = salvageReportResult({
      status: "pass",
      summary:
        "Pi successfully executed the Go fractals plan end-to-end. All tests pass.",
      reasoning:
        "Plan executed, build green, fractal renders match expectations.",
      observations: [
        { kind: "suggestion", description: "README could mention the -iterations flag" },
        { kind: "ux", description: "progress output is noisy" },
        { kind: "typo", description: "'fractle' in a comment" },
        { kind: "performance", description: "render is slow at depth 9" },
        { kind: "ug", description: "off-by-one in axis labels" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("pass");
      expect(result.value.summary).toContain("Pi successfully executed");
      expect(result.value.observations).toHaveLength(4);
      expect(result.value.observations.map((o) => o.kind)).toEqual([
        "suggestion",
        "ux",
        "typo",
        "performance",
      ]);
      expect(result.value.dropped).toHaveLength(1);
      expect(result.value.dropped[0].index).toBe(4);
      expect(result.value.dropped[0].reason).toContain("ug");
    }
  });

  test("drops an observation with a non-string description", () => {
    const result = salvageReportResult({
      status: "fail",
      summary: "x",
      reasoning: "y",
      observations: [
        { kind: "bug", description: 42 },
        { kind: "bug", description: "real one" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.observations).toHaveLength(1);
      expect(result.value.dropped).toHaveLength(1);
      expect(result.value.dropped[0].index).toBe(0);
    }
  });

  test("drops a non-object observation entry", () => {
    const result = salvageReportResult({
      status: "pass",
      summary: "x",
      reasoning: "y",
      observations: ["loose string", { kind: "ux", description: "ok" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.observations).toHaveLength(1);
      expect(result.value.dropped).toHaveLength(1);
    }
  });

  test("still decodes a JSON-stringified observations array before salvaging", () => {
    const result = salvageReportResult({
      status: "pass",
      summary: "x",
      reasoning: "y",
      observations: JSON.stringify([
        { kind: "ug", description: "truncated kind" },
        { kind: "bug", description: "valid" },
      ]),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.observations).toHaveLength(1);
      expect(result.value.dropped).toHaveLength(1);
    }
  });

  test("treats an entirely unusable observations field as drop-all, not fatal", () => {
    const result = salvageReportResult({
      status: "pass",
      summary: "x",
      reasoning: "y",
      observations: "not even json",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.observations).toEqual([]);
      expect(result.value.dropped).toHaveLength(1);
      expect(result.value.dropped[0].reason).toContain("observations");
    }
  });

  test("refuses to salvage when status is invalid", () => {
    const result = salvageReportResult({
      status: "success",
      summary: "x",
      reasoning: "y",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("status");
  });

  test("refuses to salvage when summary is missing", () => {
    const result = salvageReportResult({
      status: "pass",
      reasoning: "y",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("summary");
  });

  test("refuses to salvage non-object args", () => {
    const result = salvageReportResult("pass");
    expect(result.ok).toBe(false);
  });
});

describe("validateToolArgs", () => {
  const clickSchema: ToolDefinition["parameters"] = {
    type: "object",
    properties: {
      selector: { type: "string", description: "css selector" },
      return_screenshot: { type: "boolean" },
    },
    required: ["selector"],
  };

  const waitForSchema: ToolDefinition["parameters"] = {
    type: "object",
    properties: {
      selector: { type: "string" },
      text: { type: "string" },
      timeout: { type: "number" },
    },
  };

  const reportSchema: ToolDefinition["parameters"] = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pass", "fail", "investigate"] },
    },
    required: ["status"],
  };

  test("accepts well-formed args", () => {
    const result = validateToolArgs("click", { selector: "#btn" }, clickSchema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ selector: "#btn" });
  });

  test("rejects non-object args", () => {
    const result = validateToolArgs("click", "a string", clickSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("must be an object");
  });

  test("rejects missing required property", () => {
    const result = validateToolArgs("click", { return_screenshot: true }, clickSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("missing required");
      expect(result.reason).toContain("selector");
    }
  });

  test("rejects null for required property", () => {
    const result = validateToolArgs("click", { selector: null }, clickSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("selector");
      expect(result.reason).toContain("null");
    }
  });

  test("rejects string where object given", () => {
    const result = validateToolArgs(
      "click",
      { selector: { css: "#foo" } },
      clickSchema,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("selector");
      expect(result.reason).toContain("expected string");
    }
  });

  test("rejects wrong type for number", () => {
    const result = validateToolArgs(
      "wait_for",
      { timeout: "5000" },
      waitForSchema,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("timeout");
      expect(result.reason).toContain("expected number");
    }
  });

  test("rejects wrong type for boolean", () => {
    const result = validateToolArgs(
      "click",
      { selector: "#a", return_screenshot: "yes" },
      clickSchema,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("return_screenshot");
      expect(result.reason).toContain("expected boolean");
    }
  });

  test("rejects enum violation", () => {
    const result = validateToolArgs("report_result", { status: "success" }, reportSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("status");
      expect(result.reason).toContain("success");
    }
  });

  test("accepts when optional field is absent", () => {
    const result = validateToolArgs("wait_for", { selector: "#a" }, waitForSchema);
    expect(result.ok).toBe(true);
  });

  test("treats null optional values as absent", () => {
    // The LLM sometimes emits explicit null for optional fields. We skip
    // type-checking those rather than rejecting, which is what the
    // pre-validator `as string | undefined` code used to do implicitly.
    const result = validateToolArgs(
      "wait_for",
      { selector: "#a", text: null, timeout: null },
      waitForSchema,
    );
    expect(result.ok).toBe(true);
  });

  test("passes through when schema has no properties", () => {
    const result = validateToolArgs(
      "read_output",
      { foo: "bar" },
      { type: "object", properties: {} },
    );
    expect(result.ok).toBe(true);
  });

  test("rejects null when object expected", () => {
    const result = validateToolArgs("click", null, clickSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("must be an object");
  });

  test("rejects array at top-level (LLM sometimes wraps)", () => {
    const result = validateToolArgs("click", [{ selector: "#a" }], clickSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("must be an object");
  });
});
