import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WebAdapter } from "../../../src/adapters/web/adapter";
import { EvidenceLogger } from "../../../src/evidence/logger";

describe("WebAdapter", () => {
  test("defaultViewport reflects the constructed viewport, falling back to DEFAULT_VIEWPORT", () => {
    // Explicit constructor viewport wins.
    const custom = new WebAdapter({ viewport: { width: 1920, height: 1080 } });
    expect(custom.defaultViewport()).toEqual({ width: 1920, height: 1080 });

    // No viewport → documented fallback.
    const fallback = new WebAdapter();
    expect(fallback.defaultViewport()).toEqual({ width: 1440, height: 900 });
  });

  test("describeTarget frames the target as a URL to visit", () => {
    const adapter = new WebAdapter();
    const msg = adapter.describeTarget("https://example.com");
    expect(msg).toContain("https://example.com");
    expect(msg.toLowerCase()).toContain("available at");
  });

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

  // Nudge: the agent was defaulting to `extract` and missing visual-only
  // criteria ("is a flamingo rendered?"). The tool descriptions must
  // spell out the text-vs-pixels split so the model reaches for
  // `screenshot` without the story card having to say so.
  test("screenshot/extract descriptions cue the text-vs-pixels split", () => {
    const adapter = new WebAdapter();
    const tools = adapter.toolDefinitions();
    const screenshotDesc = tools.find((t) => t.name === "screenshot")!.description.toLowerCase();
    const extractDesc = tools.find((t) => t.name === "extract")!.description.toLowerCase();

    // screenshot: cross-references extract and names visual content.
    expect(screenshotDesc).toContain("extract");
    expect(screenshotDesc).toMatch(/image|visual|pixel/);

    // extract: calls out that images/SVG/canvas are not returned and points at screenshot.
    expect(extractDesc).toContain("screenshot");
    expect(extractDesc).toMatch(/text only|not captured|not.*text/);
  });

  test("return_screenshot descriptions cue visual-outcome usage", () => {
    const adapter = new WebAdapter();
    const tools = adapter.toolDefinitions();
    const sampled = ["click", "navigate", "wait_for", "eval"];
    for (const name of sampled) {
      const props = (tools.find((t) => t.name === name)!.parameters as any).properties;
      const desc = String(props.return_screenshot.description).toLowerCase();
      expect(desc).toMatch(/visual|image loads|modal|chart|layout/);
    }
  });

  test("omits install_passkey and install_cookies when context root is empty", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-web-nopasskey-"));
    try {
      mkdirSync(join(tmp, ".gauntlet", "context"), { recursive: true });
      const adapter = new WebAdapter({ contextRoot: join(tmp, ".gauntlet", "context") });
      const names = adapter.toolDefinitions().map((t) => t.name);
      expect(names).not.toContain("install_passkey");
      expect(names).not.toContain("install_cookies");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("omits `read` tool when no context root is set", () => {
    const adapter = new WebAdapter();
    const names = adapter.toolDefinitions().map((t) => t.name);
    expect(names).not.toContain("read");
  });

  test("omits `read` tool when context root is empty", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-web-read-empty-"));
    try {
      const adapter = new WebAdapter({ contextRoot: tmp });
      const names = adapter.toolDefinitions().map((t) => t.name);
      expect(names).not.toContain("read");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("includes `read` tool when context root is non-empty", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-web-read-"));
    try {
      mkdirSync(join(tmp, ".gauntlet", "context"), { recursive: true });
      writeFileSync(join(tmp, ".gauntlet", "context", "alice.md"), "A");
      const adapter = new WebAdapter({
        contextRoot: join(tmp, ".gauntlet", "context"),
      });
      const names = adapter.toolDefinitions().map((t) => t.name);
      expect(names).toContain("read");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("includes install_passkey and install_cookies whenever context root is non-empty (predicate does not scan filenames)", () => {
    // v1.5 (WP1.5) changed the predicate: the adapter registers
    // credential-installing tools whenever the context root exists and
    // is non-empty. It deliberately does NOT scan for `passkey.yaml` or
    // `cookies.yaml` — that would teach the runner about filename
    // conventions, which spec §2.1 forbids. If the author has no
    // credentials, the agent sees the tools in its registry but never
    // calls them.
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-web-credentials-"));
    try {
      mkdirSync(join(tmp, ".gauntlet", "context", "matt"), { recursive: true });
      // Stress the filename-blindness claim by planting files that LOOK
      // like the credential files by name but are malformed: if the
      // predicate ever started parsing them, this test would fail. The
      // tools register anyway because the predicate only checks
      // directory population.
      writeFileSync(
        join(tmp, ".gauntlet", "context", "matt", "passkey.yaml"),
        "this is not valid passkey YAML",
      );
      writeFileSync(
        join(tmp, ".gauntlet", "context", "matt", "cookies.yaml"),
        ":\n  : :",
      );
      const adapter = new WebAdapter({ contextRoot: join(tmp, ".gauntlet", "context") });
      const names = adapter.toolDefinitions().map((t) => t.name);
      expect(names).toContain("install_passkey");
      expect(names).toContain("install_cookies");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // WP1.2 — browser state reset between stories (spec §5.1)
  //
  // These tests stub the chrome-ws-lib module so we can verify the
  // ordering and arguments of the lifecycle calls without actually
  // launching Chrome. The stubs are restored in `finally` so the rest
  // of the test suite (and the e2e smoke tests that use real Chrome)
  // is unaffected.
  describe("WP1.2 — browser state reset", () => {
    // PRI-1436: chrome-ws-lib is now per-session. Each test builds a
    // record-stub session and injects it into WebAdapter via the
    // `chromeSession` option. No module-level mutation, so tests are
    // isolated from each other and from production code paths.
    type Call = [string, unknown[]];

    function makeStubSession(
      overrides: Record<string, (...args: unknown[]) => unknown> = {},
    ): { session: Record<string, (...args: unknown[]) => unknown>; calls: Call[] } {
      const calls: Call[] = [];
      const record = (name: string) => (...args: unknown[]) => {
        calls.push([name, args]);
        const o = overrides[name];
        return o ? o(...args) : undefined;
      };
      const session: Record<string, (...args: unknown[]) => unknown> = {};
      const keys = [
        "startChrome",
        "navigate",
        "clearBrowserData",
        "killChrome",
        "openObserverSession",
        "getChromeProfileDir",
        // Used elsewhere on the session — stubs default to no-op record so
        // accidental calls don't blow up the test with "not a function".
        "setEndpoint",
      ];
      for (const k of keys) {
        session[k] = record(k);
      }
      return { session, calls };
    }

    test("local mode: startChrome receives the per-run profile name", async () => {
      const { session, calls } = makeStubSession();
      const adapter = new WebAdapter({
        chromeProfileName: "gauntlet-run-abc123-card1",
        chromeSession: session,
      });
      await adapter.start("http://localhost:3000/");
      const startCall = calls.find((c) => c[0] === "startChrome");
      expect(startCall).toBeDefined();
      // signature: startChrome(headless, profileName, port?)
      expect(startCall![1][0]).toBe(true);
      expect(startCall![1][1]).toBe("gauntlet-run-abc123-card1");
      // clearBrowserData must NOT fire in local mode
      const clear = calls.find((c) => c[0] === "clearBrowserData");
      expect(clear).toBeUndefined();
    });

    test("local mode: close() deletes the per-run profile dir after killChrome", async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), "gauntlet-profile-cleanup-"));
      const fakeProfileDir = join(tmpRoot, "gauntlet-run-xyz-cardA");
      mkdirSync(fakeProfileDir, { recursive: true });
      writeFileSync(join(fakeProfileDir, "sentinel"), "x");

      const order: string[] = [];
      const { session } = makeStubSession({
        killChrome: () => { order.push("killChrome"); },
        getChromeProfileDir: (name: unknown) => {
          order.push(`getChromeProfileDir:${name}`);
          return fakeProfileDir;
        },
      });
      try {
        const adapter = new WebAdapter({
          chromeProfileName: "gauntlet-run-xyz-cardA",
          chromeSession: session,
        });
        await adapter.close();
        // Ordering: killChrome runs BEFORE the profile-dir lookup/cleanup.
        const killIdx = order.indexOf("killChrome");
        const lookupIdx = order.findIndex((s) => s.startsWith("getChromeProfileDir"));
        expect(killIdx).toBeGreaterThanOrEqual(0);
        expect(lookupIdx).toBeGreaterThan(killIdx);
        // Directory must be gone.
        expect(existsSync(fakeProfileDir)).toBe(false);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    test("local mode without chromeProfileName: close() skips profile cleanup", async () => {
      const { session, calls } = makeStubSession();
      const adapter = new WebAdapter({ chromeSession: session });
      await adapter.close();
      const lookup = calls.find((c) => c[0] === "getChromeProfileDir");
      expect(lookup).toBeUndefined();
    });

    test("local mode: cleanup of a missing profile dir does not throw (best-effort contract)", async () => {
      // rm with recursive+force swallows ENOENT, but we verify the
      // best-effort contract at the adapter level: if the profile dir
      // doesn't exist (e.g., Chrome never actually launched), close()
      // must still succeed.
      const { session } = makeStubSession({
        getChromeProfileDir: () => "/nonexistent/should/not/matter/gauntlet-run-ghost",
      });
      const adapter = new WebAdapter({
        chromeProfileName: "gauntlet-run-ghost-card",
        chromeSession: session,
      });
      await adapter.close();
      // Just having reached here is the contract: no throw.
      expect(true).toBe(true);
    });

    test("remote mode: clearBrowserData is invoked on start() after navigate", async () => {
      const order: string[] = [];
      const { session, calls } = makeStubSession({
        navigate: () => { order.push("navigate"); },
        clearBrowserData: () => { order.push("clearBrowserData"); },
      });
      const adapter = new WebAdapter({
        chrome: { host: "remote-host", port: 9333 },
        chromeProfileName: "gauntlet-run-remote-card",
        chromeSession: session,
      });
      await adapter.start("http://localhost:3000/");
      // startChrome must NOT be called in remote mode.
      const startCall = calls.find((c) => c[0] === "startChrome");
      expect(startCall).toBeUndefined();
      // navigate -> clearBrowserData ordering
      const navIdx = order.indexOf("navigate");
      const clearIdx = order.indexOf("clearBrowserData");
      expect(navIdx).toBeGreaterThanOrEqual(0);
      expect(clearIdx).toBeGreaterThan(navIdx);
      // clearBrowserData's argument is the tab index (0)
      const clearCall = calls.find((c) => c[0] === "clearBrowserData");
      expect(clearCall![1][0]).toBe(0);
    });

    test("remote mode: close() does not kill Chrome or clean up any profile dir", async () => {
      const { session, calls } = makeStubSession();
      const adapter = new WebAdapter({
        chrome: { host: "remote-host", port: 9334 },
        chromeProfileName: "gauntlet-run-remote-card",
        chromeSession: session,
      });
      await adapter.close();
      expect(calls.find((c) => c[0] === "killChrome")).toBeUndefined();
      expect(calls.find((c) => c[0] === "getChromeProfileDir")).toBeUndefined();
    });
  });

  // extract (no selector) returns the full markdown inline so the model
  // can actually read it. Run.jsonl readability is handled downstream by
  // the logger's oversize-text spill — not by the adapter — so the model
  // never ends up with a dangling artifact path it can't resolve.
  describe("extract (no selector)", () => {
    // PRI-1436: stub the per-adapter session via the chromeSession option.
    test("full-page markdown is returned inline as tool_result text", async () => {
      const big = "x".repeat(50_000);
      const session: Record<string, unknown> = {
        generateMarkdown: async () => big,
      };
      const outDir = mkdtempSync(join(tmpdir(), "gauntlet-extract-"));
      try {
        const logger = new EvidenceLogger(outDir);
        const adapter = new WebAdapter({ chromeSession: session as never });
        const result = await adapter.executeTool("extract", {}, logger);
        expect(result.text).toBe(big);
        expect(result.artifactPath).toBeUndefined();
        // The adapter does not touch artifacts/ directly — that's the
        // logger's job when it records tool_result (and only when the
        // text exceeds its inline limit, covered in logger tests).
        expect(logger.artifacts).toEqual([]);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  // PRI-1439 — side-trip tabs (new_tab/close_tab). The adapter exposes a
  // tight two-tool surface for opening a side tab during a sign-in flow
  // (OTP retrieval, password manager, 2FA portal handoff) and returning
  // to the original tab with its form state intact. Existing tools'
  // schemas are unchanged; their dispatches transparently target the
  // top of the focus stack.
  describe("PRI-1439 — side-trip tabs", () => {
    type Call = [string, unknown[]];

    interface SideTripStub {
      session: Record<string, (...args: unknown[]) => unknown>;
      calls: Call[];
      tabs: { webSocketDebuggerUrl: string }[];
      // Allow tests to override newTab/closeTab/getTabs behavior.
      setNewTabError: (err: Error | null) => void;
    }

    function makeSideTripStub(): SideTripStub {
      // Initial state: chrome has one tab (the original) at index 0.
      const tabs: { webSocketDebuggerUrl: string }[] = [
        { webSocketDebuggerUrl: "ws://stub/0" },
      ];
      let newTabCounter = 1;
      let newTabError: Error | null = null;
      const calls: Call[] = [];
      const record = (name: string) => (...args: unknown[]) => {
        calls.push([name, args]);
        return undefined;
      };
      const session: Record<string, (...args: unknown[]) => unknown> = {
        // Lifecycle stubs.
        startChrome: record("startChrome"),
        clearBrowserData: record("clearBrowserData"),
        killChrome: record("killChrome"),
        openObserverSession: record("openObserverSession"),
        getChromeProfileDir: record("getChromeProfileDir"),
        // Tab management.
        getTabs: (...args: unknown[]) => {
          calls.push(["getTabs", args]);
          return Promise.resolve([...tabs]);
        },
        newTab: (...args: unknown[]) => {
          calls.push(["newTab", args]);
          if (newTabError) return Promise.reject(newTabError);
          const wsUrl = `ws://stub/${newTabCounter++}`;
          const tab = { webSocketDebuggerUrl: wsUrl };
          tabs.push(tab);
          return Promise.resolve(tab);
        },
        closeTab: (...args: unknown[]) => {
          calls.push(["closeTab", args]);
          const target = args[0] as string;
          const idx = tabs.findIndex((t) => t.webSocketDebuggerUrl === target);
          if (idx >= 0) tabs.splice(idx, 1);
          return Promise.resolve();
        },
        // Navigation + dispatch stubs — record call args (especially the
        // tab specifier passed as the first arg) so tests can assert
        // routing.
        navigate: record("navigate"),
        click: record("click"),
        fill: record("fill"),
        keyboardPress: record("keyboardPress"),
        hover: record("hover"),
        doubleClick: record("doubleClick"),
        rightClick: record("rightClick"),
        drag: record("drag"),
        mouseMove: record("mouseMove"),
        scroll: record("scroll"),
        fileUpload: record("fileUpload"),
        extractText: record("extractText"),
        generateMarkdown: record("generateMarkdown"),
        evaluate: record("evaluate"),
        waitForElement: record("waitForElement"),
        waitForText: record("waitForText"),
        screenshot: record("screenshot"),
      };
      return {
        session,
        calls,
        tabs,
        setNewTabError: (err) => { newTabError = err; },
      };
    }

    function tmpLogger() {
      const dir = mkdtempSync(join(tmpdir(), "gauntlet-side-trip-"));
      const logger = new EvidenceLogger(dir);
      return { logger, dir };
    }

    test("toolDefinitions exposes new_tab and close_tab with expected shapes", () => {
      const adapter = new WebAdapter();
      const tools = adapter.toolDefinitions();
      const names = tools.map((t) => t.name);
      expect(names).toContain("new_tab");
      expect(names).toContain("close_tab");

      const newTab = tools.find((t) => t.name === "new_tab")!;
      const newTabProps = (newTab.parameters as any).properties;
      const newTabRequired = (newTab.parameters as any).required;
      expect(newTabProps.url).toBeDefined();
      expect(newTabProps.url.type).toBe("string");
      expect(newTabRequired).toContain("url");

      const closeTab = tools.find((t) => t.name === "close_tab")!;
      const closeTabRequired = (closeTab.parameters as any).required;
      // close_tab takes nothing required — only the optional return_screenshot.
      expect(closeTabRequired === undefined || closeTabRequired.length === 0).toBe(true);
    });

    test("after start(), dispatches use the original tab's WS URL", async () => {
      const stub = makeSideTripStub();
      const { logger, dir } = tmpLogger();
      try {
        const adapter = new WebAdapter({ chromeSession: stub.session as never });
        await adapter.start("https://example.com/");
        await adapter.executeTool("click", { selector: "#x" }, logger);
        const click = stub.calls.find((c) => c[0] === "click");
        expect(click).toBeDefined();
        expect(click![1][0]).toBe("ws://stub/0");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("new_tab pushes; subsequent dispatches hit the new tab", async () => {
      const stub = makeSideTripStub();
      const { logger, dir } = tmpLogger();
      try {
        const adapter = new WebAdapter({ chromeSession: stub.session as never });
        await adapter.start("https://example.com/");
        const result = await adapter.executeTool(
          "new_tab",
          { url: "https://mail.example/" },
          logger,
        );
        expect(result.text).toContain("opened tab");
        expect(result.text).toContain("depth 2");
        await adapter.executeTool("click", { selector: "#otp" }, logger);
        // The newTab call routed to chrome.newTab with the side-trip URL.
        const newTabCall = stub.calls.find((c) => c[0] === "newTab");
        expect(newTabCall![1][0]).toBe("https://mail.example/");
        // Subsequent click hit the new tab's WS URL (ws://stub/1, the
        // first counter value the stub hands out).
        const clickCalls = stub.calls.filter((c) => c[0] === "click");
        expect(clickCalls).toHaveLength(1);
        expect(clickCalls[0][1][0]).toBe("ws://stub/1");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("close_tab pops; dispatches return to the original tab", async () => {
      const stub = makeSideTripStub();
      const { logger, dir } = tmpLogger();
      try {
        const adapter = new WebAdapter({ chromeSession: stub.session as never });
        await adapter.start("https://example.com/");
        await adapter.executeTool("new_tab", { url: "https://mail.example/" }, logger);
        const closeResult = await adapter.executeTool("close_tab", {}, logger);
        expect(closeResult.text).toContain("closed tab");
        expect(closeResult.text).toContain("depth 1");
        await adapter.executeTool("click", { selector: "#submit" }, logger);
        // closeTab was called with the side-trip URL.
        const closeCall = stub.calls.find((c) => c[0] === "closeTab");
        expect(closeCall![1][0]).toBe("ws://stub/1");
        // Post-pop click hit the original tab.
        const clickCalls = stub.calls.filter((c) => c[0] === "click");
        expect(clickCalls).toHaveLength(1);
        expect(clickCalls[0][1][0]).toBe("ws://stub/0");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("close_tab refuses at depth 1 (the original tab)", async () => {
      const stub = makeSideTripStub();
      const { logger, dir } = tmpLogger();
      try {
        const adapter = new WebAdapter({ chromeSession: stub.session as never });
        await adapter.start("https://example.com/");
        const result = await adapter.executeTool("close_tab", {}, logger);
        expect(result.text).toMatch(/cannot close the original tab/i);
        expect(result.text).toContain("navigate");
        // Stub's closeTab must not have been called.
        const closeCall = stub.calls.find((c) => c[0] === "closeTab");
        expect(closeCall).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("new_tab refuses at the depth cap (5) without calling chrome.newTab", async () => {
      const stub = makeSideTripStub();
      const { logger, dir } = tmpLogger();
      try {
        const adapter = new WebAdapter({ chromeSession: stub.session as never });
        await adapter.start("https://example.com/");
        // Push 4 side-trip tabs (depth 5 total).
        for (let i = 0; i < 4; i++) {
          const r = await adapter.executeTool("new_tab", { url: `https://side${i}/` }, logger);
          expect(r.text).toContain("opened tab");
        }
        const newTabCallsBefore = stub.calls.filter((c) => c[0] === "newTab").length;
        const overflow = await adapter.executeTool(
          "new_tab",
          { url: "https://overflow/" },
          logger,
        );
        expect(overflow.text).toMatch(/too many side-trip tabs/i);
        const newTabCallsAfter = stub.calls.filter((c) => c[0] === "newTab").length;
        expect(newTabCallsAfter).toBe(newTabCallsBefore);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("new_tab failure does not push the stack", async () => {
      const stub = makeSideTripStub();
      stub.setNewTabError(new Error("chrome unreachable"));
      const { logger, dir } = tmpLogger();
      try {
        const adapter = new WebAdapter({ chromeSession: stub.session as never });
        await adapter.start("https://example.com/");
        const result = await adapter.executeTool(
          "new_tab",
          { url: "https://mail.example/" },
          logger,
        );
        expect(result.text).toContain("Error");
        expect(result.text).toContain("chrome unreachable");
        await adapter.executeTool("click", { selector: "#x" }, logger);
        // Click still hits the original tab — the failed new_tab did not push.
        const click = stub.calls.find((c) => c[0] === "click");
        expect(click![1][0]).toBe("ws://stub/0");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("logs tab_focus_changed events on push and pop", async () => {
      const stub = makeSideTripStub();
      const { logger, dir } = tmpLogger();
      try {
        const events: Array<{ name: string; data: Record<string, unknown> }> = [];
        const original = logger.logEvent.bind(logger);
        logger.logEvent = (name: string, data: Record<string, unknown>) => {
          events.push({ name, data });
          return original(name, data);
        };
        const adapter = new WebAdapter({ chromeSession: stub.session as never });
        await adapter.start("https://example.com/");
        await adapter.executeTool("new_tab", { url: "https://mail.example/" }, logger);
        await adapter.executeTool("close_tab", {}, logger);
        const focusEvents = events.filter((e) => e.name === "tab_focus_changed");
        expect(focusEvents).toHaveLength(2);
        expect(focusEvents[0].data.action).toBe("push");
        expect(focusEvents[0].data.depth).toBe(2);
        expect(focusEvents[1].data.action).toBe("pop");
        expect(focusEvents[1].data.depth).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("close() force-closes any side-trip tabs the agent left open", async () => {
      const stub = makeSideTripStub();
      const { logger, dir } = tmpLogger();
      try {
        const adapter = new WebAdapter({ chromeSession: stub.session as never });
        await adapter.start("https://example.com/");
        await adapter.executeTool("new_tab", { url: "https://side1/" }, logger);
        await adapter.executeTool("new_tab", { url: "https://side2/" }, logger);
        await adapter.close();
        const closeCalls = stub.calls.filter((c) => c[0] === "closeTab");
        // Two side trips were left open; both should be closed on teardown
        // (LIFO — top of stack first).
        expect(closeCalls).toHaveLength(2);
        expect(closeCalls[0][1][0]).toBe("ws://stub/2");
        expect(closeCalls[1][1][0]).toBe("ws://stub/1");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // The whole AppConfig refactor depends on this thread:
  //   AppConfig.defaultChrome → mergeRunConfig → WebAdapter({chrome}) →
  //   createSession({ host, port }) → host-override per-instance state.
  // PRI-1436: pre-1436 this went via chrome-ws-lib.setEndpoint() which
  // mutated module-level state and broke under concurrency. Now each
  // WebAdapter constructs its own session seeded from the chrome option.
  // Cover it directly so a regression in any link of the chain is caught.
  describe("constructor → createSession threading", () => {
    test("explicit chrome creates a session bound to that endpoint and sets remote=true", () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createSession } = require("../../../src/adapters/web/lib/chrome-ws-lib");
      const adapter = new WebAdapter({ chrome: { host: "remote-host", port: 9333 } });
      // The adapter must have a session whose hostOverride sees the
      // endpoint we passed in. We can't reach inside, but the session it
      // constructed has a getChromeSession() escape hatch — round-trip
      // a probe through it.
      const session = adapter.getChromeSession();
      expect(session).toBeDefined();
      // Compare against a fresh session built with the same options:
      // both should report the same host and port via getActivePort()
      // and (indirectly) via the host-override they hold.
      const reference = createSession({ host: "remote-host", port: 9333 });
      expect(session.getActivePort()).toBe(reference.getActivePort());
    });

    test("no chrome option produces a session with default endpoint", () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createSession } = require("../../../src/adapters/web/lib/chrome-ws-lib");
      const adapter = new WebAdapter({});
      const adapter2 = new WebAdapter();
      const reference = createSession();
      // Both no-arg adapters should share the default port that a fresh
      // no-arg session reports.
      expect(adapter.getChromeSession().getActivePort()).toBe(reference.getActivePort());
      expect(adapter2.getChromeSession().getActivePort()).toBe(reference.getActivePort());
    });
  });
});
