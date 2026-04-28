import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as YAML from "yaml";
import {
  buildInstallCookiesTool,
  readCookiesFile,
  type CookieParam,
  type CookiesDriver,
  type SetCookieResult,
} from "../../../src/adapters/web/cookies";
import type { EvidenceLogger } from "../../../src/evidence/logger";

// Sample cookie set used across tests. Origin info is provided via
// `domain` for two and `url` for one to exercise both forms. The .test
// TLD prevents any accidental real-site collision.
const SAMPLE_COOKIES: CookieParam[] = [
  {
    name: "_session",
    value: "sess-abc-123",
    domain: ".example.test",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  },
  {
    name: "_csrf",
    value: "csrf-deadbeef",
    domain: ".example.test",
    path: "/",
    secure: true,
    sameSite: "Strict",
  },
  {
    name: "remember_me",
    value: "rmb-1",
    url: "https://example.test/",
    secure: true,
  },
];

// ---------------------------------------------------------------------------
// readCookiesFile: parses an already-resolved absolute path, validates each
// entry, and returns the cookie array verbatim (no normalization).
// ---------------------------------------------------------------------------

describe("readCookiesFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gauntlet-cookies-read-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("parses a valid cookies YAML (list of entries)", () => {
    const dir = join(tmp, ".gauntlet", "context", "matt");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "cookies.yaml");
    writeFileSync(filePath, YAML.stringify(SAMPLE_COOKIES));
    const cookies = readCookiesFile(filePath);
    expect(cookies).toHaveLength(3);
    expect(cookies[0].name).toBe("_session");
    expect(cookies[0].value).toBe("sess-abc-123");
    expect(cookies[0].domain).toBe(".example.test");
    expect(cookies[0].sameSite).toBe("Lax");
    expect(cookies[2].url).toBe("https://example.test/");
    expect(cookies[2].domain).toBeUndefined();
  });

  test("throws when the cookies file does not exist", () => {
    const filePath = join(tmp, "ghost", "cookies.yaml");
    expect(() => readCookiesFile(filePath)).toThrow();
  });

  test("throws on malformed YAML with line/column info from the parser", () => {
    const dir = join(tmp, ".gauntlet", "context", "bad");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "cookies.yaml");
    // Structurally invalid: keyless mapping with garbage values.
    writeFileSync(filePath, ":\n  : :");
    expect(() => readCookiesFile(filePath)).toThrow(/invalid YAML/);
  });

  test("throws when the document is not a list", () => {
    const dir = join(tmp, ".gauntlet", "context", "wrongshape");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "cookies.yaml");
    writeFileSync(filePath, YAML.stringify({ name: "x", value: "y", url: "https://e.test/" }));
    expect(() => readCookiesFile(filePath)).toThrow(/list/);
  });

  test("throws when a required field is missing (name)", () => {
    const dir = join(tmp, ".gauntlet", "context", "noname");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "cookies.yaml");
    writeFileSync(
      filePath,
      YAML.stringify([{ value: "v", url: "https://e.test/" }]),
    );
    expect(() => readCookiesFile(filePath)).toThrow(/name/);
  });

  test("throws when a required field is missing (value)", () => {
    const dir = join(tmp, ".gauntlet", "context", "noval");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "cookies.yaml");
    writeFileSync(
      filePath,
      YAML.stringify([{ name: "_x", url: "https://e.test/" }]),
    );
    expect(() => readCookiesFile(filePath)).toThrow(/value/);
  });

  test("throws when origin info is missing (no url, no domain)", () => {
    const dir = join(tmp, ".gauntlet", "context", "noorigin");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "cookies.yaml");
    writeFileSync(filePath, YAML.stringify([{ name: "_x", value: "y" }]));
    expect(() => readCookiesFile(filePath)).toThrow(/url|domain/);
  });

  test("throws on a typo'd `samesite` (should be `sameSite`) with a hint", () => {
    const dir = join(tmp, ".gauntlet", "context", "samesite");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "cookies.yaml");
    writeFileSync(
      filePath,
      YAML.stringify([
        { name: "_x", value: "y", url: "https://e.test/", samesite: "Lax" },
      ]),
    );
    expect(() => readCookiesFile(filePath)).toThrow(/sameSite/);
  });

  test("throws on an unknown field with a generic message", () => {
    const dir = join(tmp, ".gauntlet", "context", "unknown");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "cookies.yaml");
    writeFileSync(
      filePath,
      YAML.stringify([
        { name: "_x", value: "y", url: "https://e.test/", banana: "split" },
      ]),
    );
    expect(() => readCookiesFile(filePath)).toThrow(/banana/);
  });

  test("accepts both url form and domain+path form on the same entry", () => {
    // Note: CDP allows specifying both — domain+path acts as a fallback
    // when url is omitted. We don't try to enforce mutual exclusion here;
    // Chrome's setCookie is the source of truth on what it accepts.
    const dir = join(tmp, ".gauntlet", "context", "bothforms");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "cookies.yaml");
    writeFileSync(
      filePath,
      YAML.stringify([
        { name: "a", value: "1", url: "https://e.test/" },
        { name: "b", value: "2", domain: "e.test", path: "/" },
      ]),
    );
    const cookies = readCookiesFile(filePath);
    expect(cookies).toHaveLength(2);
    expect(cookies[0].url).toBe("https://e.test/");
    expect(cookies[1].domain).toBe("e.test");
    expect(cookies[1].path).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// buildInstallCookiesTool: tool definition, registration predicate, execute
// path (resolveInside + readCookiesFile + driver.setCookies + aggregate).
// No teardown — cookies are browser-state, not session-state.
// ---------------------------------------------------------------------------

interface DriverCalls {
  setCookies: Array<{ tab: number; cookies: CookieParam[] }>;
}

function makeDriver(
  results: SetCookieResult[] | "throw",
): { driver: CookiesDriver; calls: DriverCalls } {
  const calls: DriverCalls = { setCookies: [] };
  const driver: CookiesDriver = {
    async setCookies(tab, cookies) {
      calls.setCookies.push({ tab, cookies });
      if (results === "throw") {
        throw new Error("CDP timeout");
      }
      return results;
    },
  };
  return { driver, calls };
}

interface LoggedAction { action: string; params: Record<string, unknown> }

function makeFakeLogger(): { logger: EvidenceLogger; actions: LoggedAction[] } {
  const actions: LoggedAction[] = [];
  const logger = {
    logEvent(action: string, params: Record<string, unknown>) {
      actions.push({ action, params });
    },
    logAction(action: string, params: Record<string, unknown>) {
      actions.push({ action, params });
    },
  } as unknown as EvidenceLogger;
  return { logger, actions };
}

// Creates `<tmp>/.gauntlet/context/<name>/cookies.yaml` for each name
// (with SAMPLE_COOKIES content) and returns the context root directory.
function setupContext(tmp: string, names: string[]): string {
  const root = join(tmp, ".gauntlet", "context");
  mkdirSync(root, { recursive: true });
  for (const n of names) {
    mkdirSync(join(root, n));
    writeFileSync(join(root, n, "cookies.yaml"), YAML.stringify(SAMPLE_COOKIES));
  }
  return root;
}

function allOk(cookies: CookieParam[]): SetCookieResult[] {
  return cookies.map((c) => ({ name: c.name, success: true }));
}

describe("buildInstallCookiesTool", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gauntlet-cookies-tool-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns null when contextRoot does not exist", () => {
    const root = join(tmp, ".gauntlet", "context");
    expect(buildInstallCookiesTool(root, 0, makeDriver([]).driver)).toBeNull();
  });

  test("returns null when contextRoot is empty", () => {
    const root = join(tmp, ".gauntlet", "context");
    mkdirSync(root, { recursive: true });
    expect(buildInstallCookiesTool(root, 0, makeDriver([]).driver)).toBeNull();
  });

  test("returns null when contextRoot is a file, not a directory", () => {
    const root = join(tmp, "notadir");
    writeFileSync(root, "x");
    expect(buildInstallCookiesTool(root, 0, makeDriver([]).driver)).toBeNull();
  });

  test("registers when contextRoot is non-empty even without cookies.yaml files", () => {
    // Mirrors the install_passkey predicate: non-empty directory only.
    // The runner does not scan for `cookies.yaml` (spec §2.1 — runner
    // does not interpret filenames).
    const root = join(tmp, ".gauntlet", "context");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "alice.md"), "flat profile, no cookies");
    const tool = buildInstallCookiesTool(root, 0, makeDriver([]).driver);
    expect(tool).not.toBeNull();
  });

  test("tool definition has a required `path` parameter", () => {
    const root = setupContext(tmp, ["alice"]);
    const tool = buildInstallCookiesTool(root, 0, makeDriver([]).driver)!;
    expect(tool.definition.name).toBe("install_cookies");
    const params = tool.definition.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.properties).toHaveProperty("path");
    expect(params.required).toEqual(["path"]);
  });

  test("tool description matches spec §3.4 verbatim (load-bearing prose)", () => {
    // Guards the "Call this once, before navigating to a cookie-gated
    // origin" / "Cookies persist across same-origin navigations" /
    // "you must navigate again after installing" clauses. Ponder's
    // prose-break note in §3.4 records that these three sentences are
    // load-bearing — without them the agent does not understand the
    // lifecycle difference from passkeys (which clear on navigate).
    // Any edit must go through the spec amendment protocol.
    const root = setupContext(tmp, ["alice"]);
    const tool = buildInstallCookiesTool(root, 0, makeDriver([]).driver)!;
    const expected =
      "Install cookies into the browser, reading them from a YAML file under " +
      "the project's context directory. The path is relative to " +
      ".gauntlet/context/ (example: \"alice/cookies.yaml\"). The file is a list " +
      "of cookie entries; each entry mirrors Chrome's Network.setCookie " +
      "parameters (name, value, plus either url or domain+path, and optional " +
      "secure, httpOnly, sameSite, expires). Call this once, before navigating " +
      "to a cookie-gated origin. Cookies persist across same-origin " +
      "navigations; you do not need to re-call this tool. Note that the " +
      "browser performs an initial navigate before any tool runs, so for apps " +
      "that require a session cookie you must navigate again after installing. " +
      "The tool returns a per-cookie summary: how many were accepted, and " +
      "which entries (if any) Chrome rejected and why.";
    expect(tool.definition.description).toBe(expected);
  });

  test("the returned tool object has no teardown method (cookies are browser-state)", () => {
    const root = setupContext(tmp, ["alice"]);
    const tool = buildInstallCookiesTool(root, 0, makeDriver([]).driver)!;
    expect((tool as Record<string, unknown>).teardown).toBeUndefined();
  });

  test("success path: parses, dispatches once, logs install_cookies_ok with sanitized context (no value bytes)", async () => {
    const root = setupContext(tmp, ["matt"]);
    const { driver, calls } = makeDriver(allOk(SAMPLE_COOKIES));
    const { logger, actions } = makeFakeLogger();
    const tool = buildInstallCookiesTool(root, 0, driver, logger)!;

    const result = await tool.execute({ path: "matt/cookies.yaml" });
    expect(result.text).toContain("Installed 3");
    expect(result.text).toContain("matt/cookies.yaml");
    expect(result.text).toContain("_session");
    expect(result.text).toContain("_csrf");
    expect(result.text).toContain("remember_me");
    expect(result.text.toLowerCase()).not.toContain("error");

    // Driver hit exactly once with all three cookies.
    expect(calls.setCookies).toHaveLength(1);
    expect(calls.setCookies[0].tab).toBe(0);
    expect(calls.setCookies[0].cookies).toHaveLength(3);

    // install_cookies_ok action log entry present, with sanitized context.
    const ok = actions.find((a) => a.action === "install_cookies_ok");
    expect(ok).toBeDefined();
    expect(ok!.params.path).toBe("matt/cookies.yaml");
    expect(ok!.params.accepted).toBe(3);
    expect(ok!.params.rejected).toBe(0);
    // Sensitive bytes — cookie *values* — must NEVER appear in the log.
    const serialized = JSON.stringify(ok!.params);
    for (const c of SAMPLE_COOKIES) {
      expect(serialized).not.toContain(c.value);
    }
    // valueLength is recorded per cookie so reviewers can sanity-check
    // sizes without seeing the bytes.
    const cookies = ok!.params.cookies as Array<Record<string, unknown>>;
    expect(cookies).toHaveLength(3);
    expect(cookies[0].name).toBe("_session");
    expect(cookies[0].valueLength).toBe(SAMPLE_COOKIES[0].value.length);
    expect(cookies[0]).not.toHaveProperty("value");
  });

  test("partial success: rejected cookies are called out by name with reason; log includes rejected count", async () => {
    const root = setupContext(tmp, ["matt"]);
    const driverResults: SetCookieResult[] = [
      { name: "_session", success: true },
      { name: "_csrf", success: true },
      {
        name: "remember_me",
        success: false,
        errorReason: "chrome rejected cookie (no detail provided)",
      },
    ];
    const { driver } = makeDriver(driverResults);
    const { logger, actions } = makeFakeLogger();
    const tool = buildInstallCookiesTool(root, 0, driver, logger)!;

    const result = await tool.execute({ path: "matt/cookies.yaml" });
    expect(result.text).toContain("Installed 2/3");
    expect(result.text).toContain("Accepted");
    expect(result.text).toContain("_session");
    expect(result.text).toContain("_csrf");
    expect(result.text).toContain("Rejected");
    expect(result.text).toContain("remember_me");
    expect(result.text).toContain("chrome rejected cookie (no detail provided)");

    // Tool-level success — the agent gets to learn what failed and why.
    expect(result.text.toLowerCase()).not.toMatch(/^error/);

    const ok = actions.find((a) => a.action === "install_cookies_ok");
    expect(ok).toBeDefined();
    expect(ok!.params.accepted).toBe(2);
    expect(ok!.params.rejected).toBe(1);
  });

  test("missing path argument returns an error and logs validate_args failure", async () => {
    const root = setupContext(tmp, ["matt"]);
    const { driver, calls } = makeDriver([]);
    const { logger, actions } = makeFakeLogger();
    const tool = buildInstallCookiesTool(root, 0, driver, logger)!;

    const missing = await tool.execute({});
    expect(missing.text.toLowerCase()).toContain("error");
    expect(missing.text.toLowerCase()).toContain("path");
    // Did not hit the driver.
    expect(calls.setCookies).toHaveLength(0);

    const failure = actions.find((a) => a.action === "install_cookies_failed");
    expect(failure).toBeDefined();
    expect(failure!.params.step).toBe("validate_args");
  });

  test("path that escapes contextRoot is rejected at resolve_path", async () => {
    const root = setupContext(tmp, ["matt"]);
    writeFileSync(join(tmp, "secret.yaml"), YAML.stringify(SAMPLE_COOKIES));
    const { driver, calls } = makeDriver([]);
    const { logger, actions } = makeFakeLogger();
    const tool = buildInstallCookiesTool(root, 0, driver, logger)!;

    const escape = await tool.execute({ path: "../secret.yaml" });
    expect(escape.text.toLowerCase()).toContain("error");
    expect(calls.setCookies).toHaveLength(0);
    const failure = actions.find((a) => a.action === "install_cookies_failed");
    expect(failure).toBeDefined();
    expect(failure!.params.step).toBe("resolve_path");
  });

  test("absolute path is rejected at resolve_path", async () => {
    const root = setupContext(tmp, ["matt"]);
    const { driver, calls } = makeDriver([]);
    const { logger, actions } = makeFakeLogger();
    const tool = buildInstallCookiesTool(root, 0, driver, logger)!;

    const abs = await tool.execute({ path: join(root, "matt", "cookies.yaml") });
    expect(abs.text.toLowerCase()).toContain("error");
    expect(calls.setCookies).toHaveLength(0);
    const failure = actions.find((a) => a.action === "install_cookies_failed");
    expect(failure).toBeDefined();
    expect(failure!.params.step).toBe("resolve_path");
  });

  test("path pointing at a non-existent file surfaces as read_cookies error", async () => {
    const root = setupContext(tmp, ["matt"]);
    const { driver, calls } = makeDriver([]);
    const { logger, actions } = makeFakeLogger();
    const tool = buildInstallCookiesTool(root, 0, driver, logger)!;

    const ghost = await tool.execute({ path: "ghost/cookies.yaml" });
    expect(ghost.text.toLowerCase()).toContain("error");
    expect(calls.setCookies).toHaveLength(0);
    const failure = actions.find((a) => a.action === "install_cookies_failed");
    expect(failure).toBeDefined();
    expect(failure!.params.step).toBe("read_cookies");
  });

  test("driver throw surfaces as set_cookies step error and logs install_cookies_failed", async () => {
    const root = setupContext(tmp, ["matt"]);
    const { driver } = makeDriver("throw");
    const { logger, actions } = makeFakeLogger();
    const tool = buildInstallCookiesTool(root, 0, driver, logger)!;

    const result = await tool.execute({ path: "matt/cookies.yaml" });
    expect(result.text.toLowerCase()).toContain("error");
    expect(result.text).toContain("set_cookies");
    expect(result.text).toContain("CDP timeout");

    const failure = actions.find((a) => a.action === "install_cookies_failed");
    expect(failure).toBeDefined();
    expect(failure!.params.step).toBe("set_cookies");
    expect(failure!.params.error).toBe("CDP timeout");
    // Even on driver failure, cookie values must not leak into the log.
    const serialized = JSON.stringify(failure!.params);
    for (const c of SAMPLE_COOKIES) {
      expect(serialized).not.toContain(c.value);
    }
  });
});
