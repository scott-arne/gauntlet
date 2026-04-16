import { describe, test, expect } from "bun:test";
import { runConfigCommand } from "../../src/cli/config-command";
import type { ConfigArgs } from "../../src/cli/args";

const minimalArgs = (cli = {}): ConfigArgs => ({ command: "config", json: false, cli });

describe("runConfigCommand", () => {
  test("returns JSON when json flag true", () => {
    const result = runConfigCommand({ ...minimalArgs(), json: true }, {});
    const parsed = JSON.parse(result);
    expect(parsed.gauntlet.projectRoot).toBe(".");
    expect(parsed.gauntlet.port).toBe(4400);
    expect(parsed.sdkEnv.ANTHROPIC_API_KEY).toBe("unset");
  });

  test("returns text format when json flag false", () => {
    const result = runConfigCommand(minimalArgs(), {});
    expect(result).toContain("# Gauntlet configuration");
    expect(result).toContain("projectRoot:");
    expect(result).toContain("anthropic:");
  });

  test("text output shows source attribution", () => {
    const result = runConfigCommand(
      minimalArgs({ projectRoot: "/flag" }),
      { GAUNTLET_PORT: "5500" } as NodeJS.ProcessEnv,
    );
    expect(result).toMatch(/projectRoot:\s+\/flag\s+\(flag\)/);
    expect(result).toMatch(/port:\s+5500\s+\(env\)/);
  });

  test("runConfigCommand propagates loadConfig errors (caller responsible for display)", () => {
    expect(() => runConfigCommand(
      minimalArgs(),
      { GAUNTLET_CHROME: "not-valid" } as NodeJS.ProcessEnv,
    )).toThrow(/GAUNTLET_CHROME/);
  });

  test("sdkEnv section only shows presence for secrets", () => {
    const result = runConfigCommand({ ...minimalArgs(), json: true }, {
      ANTHROPIC_API_KEY: "sk-ant-secret",
      ANTHROPIC_BASE_URL: "https://custom",
    } as NodeJS.ProcessEnv);
    const parsed = JSON.parse(result);
    expect(parsed.sdkEnv.ANTHROPIC_API_KEY).toBe("set");
    expect(parsed.sdkEnv.ANTHROPIC_BASE_URL).toBe("https://custom");
  });
});
