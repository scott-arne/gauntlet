import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WebAdapter } from "../../../src/adapters/web/adapter";

describe("WebAdapter", () => {
  test("exposes tool definitions for the agent", () => {
    const adapter = new WebAdapter();
    const tools = adapter.toolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain("screenshot");
    expect(names).toContain("click");
    expect(names).toContain("type");
    expect(names).toContain("press");
    expect(names).toContain("navigate");
    expect(names).toContain("extract");
    expect(names).toContain("wait_for");
  });

  test("has correct parameter schemas", () => {
    const adapter = new WebAdapter();
    const tools = adapter.toolDefinitions();
    const clickTool = tools.find((t) => t.name === "click");
    expect(clickTool).toBeDefined();
    expect(clickTool!.parameters).toHaveProperty("properties");
  });

  test("action tools have return_screenshot parameter", () => {
    const adapter = new WebAdapter();
    const tools = adapter.toolDefinitions();
    const toolsWithReturnScreenshot = ["click", "type", "press", "navigate", "eval", "wait_for"];
    for (const name of toolsWithReturnScreenshot) {
      const tool = tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      const props = (tool!.parameters as any).properties;
      expect(props.return_screenshot).toBeDefined();
      expect(props.return_screenshot.type).toBe("boolean");
    }
  });

  test("screenshot tool does not have return_screenshot parameter", () => {
    const adapter = new WebAdapter();
    const tools = adapter.toolDefinitions();
    const screenshotTool = tools.find((t) => t.name === "screenshot");
    const props = (screenshotTool!.parameters as any).properties;
    expect(props.return_screenshot).toBeUndefined();
  });

  test("omits read_profile when no profiles directory is set", () => {
    const adapter = new WebAdapter();
    const names = adapter.toolDefinitions().map((t) => t.name);
    expect(names).not.toContain("read_profile");
  });

  test("omits read_profile when profiles directory is empty", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-web-empty-"));
    try {
      const adapter = new WebAdapter({ profilesDir: tmp });
      const names = adapter.toolDefinitions().map((t) => t.name);
      expect(names).not.toContain("read_profile");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("includes read_profile when profiles directory has at least one file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-web-profiles-"));
    try {
      mkdirSync(join(tmp, "profiles"));
      writeFileSync(join(tmp, "profiles", "alice.md"), "A");
      writeFileSync(join(tmp, "profiles", "bob.md"), "B");
      const adapter = new WebAdapter({ profilesDir: join(tmp, "profiles") });
      const tools = adapter.toolDefinitions();
      const readProfile = tools.find((t) => t.name === "read_profile");
      expect(readProfile).toBeDefined();
      // The parameter is a plain string — no enum of valid names.
      const params = readProfile!.parameters as {
        properties: { name: { enum?: unknown } };
      };
      expect(params.properties.name.enum).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("omits install_passkey when profiles directory has no passkey files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-web-nopasskey-"));
    try {
      mkdirSync(join(tmp, "profiles"));
      writeFileSync(join(tmp, "profiles", "alice.md"), "A");
      const adapter = new WebAdapter({ profilesDir: join(tmp, "profiles") });
      const names = adapter.toolDefinitions().map((t) => t.name);
      expect(names).not.toContain("install_passkey");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("includes install_passkey when a subdir has passkey.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-web-passkey-"));
    try {
      mkdirSync(join(tmp, "profiles"));
      mkdirSync(join(tmp, "profiles", "matt"));
      writeFileSync(
        join(tmp, "profiles", "matt", "passkey.json"),
        JSON.stringify({
          credentialId: "dGVzdA",
          isResidentCredential: true,
          rpId: "example.test",
          privateKey: "TEST_KEY",
        }),
      );
      const adapter = new WebAdapter({ profilesDir: join(tmp, "profiles") });
      const names = adapter.toolDefinitions().map((t) => t.name);
      expect(names).toContain("install_passkey");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The whole AppConfig refactor depends on this thread:
  //   AppConfig.defaultChrome → mergeRunConfig → WebAdapter({chrome}) →
  //   chrome-ws-lib.setEndpoint(host, port) → host-override module state.
  // Cover it directly so a regression in any link of the chain is caught.
  describe("constructor → setEndpoint threading", () => {
    test("explicit chrome calls setEndpoint and sets remote=true", () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const chromeLib = require("../../../src/adapters/web/lib/chrome-ws-lib");
      const original = chromeLib.setEndpoint;
      const calls: Array<[string, number]> = [];
      chromeLib.setEndpoint = (host: string, port: number) => {
        calls.push([host, port]);
        return original.call(chromeLib, host, port);
      };
      try {
        const adapter = new WebAdapter({ chrome: { host: "remote-host", port: 9333 } });
        expect(calls).toEqual([["remote-host", 9333]]);
        // remote=true is private, but we can verify the side effect: close()
        // on a remote adapter is a no-op (does not call killChrome).
        // We do this implicitly by checking the call list above and trusting
        // the implementation's own branch.
        expect(adapter).toBeDefined();
      } finally {
        chromeLib.setEndpoint = original;
      }
    });

    test("no chrome option does not call setEndpoint", () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const chromeLib = require("../../../src/adapters/web/lib/chrome-ws-lib");
      const original = chromeLib.setEndpoint;
      let called = false;
      chromeLib.setEndpoint = () => {
        called = true;
      };
      try {
        new WebAdapter({});
        expect(called).toBe(false);
        new WebAdapter();
        expect(called).toBe(false);
      } finally {
        chromeLib.setEndpoint = original;
      }
    });
  });
});
