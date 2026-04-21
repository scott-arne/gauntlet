import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildInstallPasskeyTool,
  readPasskeyFile,
  type PasskeyCredential,
  type WebAuthnDriver,
  type VirtualAuthenticatorOptions,
} from "../../../src/adapters/web/passkey";
import type { EvidenceLogger } from "../../../src/evidence/logger";

// Synthetic fixture — not a real credential. rpId uses the reserved
// .test TLD so it can never collide with a live site. Byte fields are
// clean standard base64 with padding so the normalizer is a no-op.
const SAMPLE_PASSKEY = {
  credentialId: "VEVTVENSRURFTlRJQUxJRHh4eHh4eHh4eHg=",
  isResidentCredential: true,
  rpId: "example.test",
  userHandle: "VEVTVFVTRVJIQU5ETEV4eHh4eHg=",
  signCount: 0,
  privateKey: "VEVTVFBSSVZBVEVLRVl4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg=",
};

// ---------------------------------------------------------------------------
// readPasskeyFile: parses an already-resolved absolute path, validates
// required fields, and normalizes base64url byte fields to standard base64.
// ---------------------------------------------------------------------------

describe("readPasskeyFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gauntlet-passkey-read-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("parses a valid passkey JSON", () => {
    const dir = join(tmp, ".gauntlet", "context", "matt");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "passkey.json");
    writeFileSync(filePath, JSON.stringify(SAMPLE_PASSKEY));
    const pk = readPasskeyFile(filePath);
    expect(pk.credentialId).toBe(SAMPLE_PASSKEY.credentialId);
    expect(pk.rpId).toBe("example.test");
    expect(pk.isResidentCredential).toBe(true);
    expect(pk.privateKey).toBe(SAMPLE_PASSKEY.privateKey);
    expect(pk.userHandle).toBe(SAMPLE_PASSKEY.userHandle);
    expect(pk.signCount).toBe(0);
  });

  test("throws when the passkey file does not exist", () => {
    const filePath = join(tmp, "ghost", "passkey.json");
    expect(() => readPasskeyFile(filePath)).toThrow();
  });

  test("throws when the JSON is malformed", () => {
    const dir = join(tmp, ".gauntlet", "context", "bad");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "passkey.json");
    writeFileSync(filePath, "{not json");
    expect(() => readPasskeyFile(filePath)).toThrow(/invalid JSON/);
  });

  test("throws when required fields are missing", () => {
    const dir = join(tmp, ".gauntlet", "context", "partial");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "passkey.json");
    writeFileSync(
      filePath,
      JSON.stringify({ credentialId: "x", rpId: "example.com" }),
    );
    expect(() => readPasskeyFile(filePath)).toThrow(/privateKey/);
  });

  test("throws when signCount is missing (CDP requires integer)", () => {
    const dir = join(tmp, ".gauntlet", "context", "nocount");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "passkey.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        credentialId: "x",
        rpId: "example.test",
        privateKey: "k",
      }),
    );
    expect(() => readPasskeyFile(filePath)).toThrow(/signCount/);
  });

  test("normalizes byte fields to standard base64 with padding", () => {
    // CDP's WebAuthn.addCredential expects standard base64 with padding
    // (confirmed against Chrome 147), despite the protocol docs saying
    // base64url. readPasskeyFile normalizes: `-` → `+`, `_` → `/`, then
    // pads to a multiple of 4. Already-standard inputs pass through
    // unchanged.
    //
    // Chosen lengths hit every padding arm:
    //   10 chars → mod 4 == 2 → 2 pad chars
    //   11 chars → mod 4 == 3 → 1 pad char
    //   12 chars → mod 4 == 0 → no pad
    const root = join(tmp, ".gauntlet", "context");
    mkdirSync(root, { recursive: true });
    const cases = [
      {
        name: "urlform",
        json: {
          credentialId: "abc-def_gh",
          isResidentCredential: true,
          rpId: "example.test",
          privateKey: "keyMatHer-_",
          userHandle: "userHandle-_",
          signCount: 1,
        },
        expected: {
          credentialId: "abc+def/gh==",
          privateKey: "keyMatHer+/=",
          userHandle: "userHandle+/",
        },
      },
      {
        name: "stdform",
        json: {
          credentialId: "abc+def/gh==",
          isResidentCredential: true,
          rpId: "example.test",
          privateKey: "keyMatHer+/=",
          userHandle: "userHandle+/",
          signCount: 0,
        },
        expected: {
          credentialId: "abc+def/gh==",
          privateKey: "keyMatHer+/=",
          userHandle: "userHandle+/",
        },
      },
    ];
    for (const c of cases) {
      const dir = join(root, c.name);
      mkdirSync(dir);
      const filePath = join(dir, "passkey.json");
      writeFileSync(filePath, JSON.stringify(c.json));
      const pk = readPasskeyFile(filePath);
      expect(pk.credentialId).toBe(c.expected.credentialId);
      expect(pk.privateKey).toBe(c.expected.privateKey);
      expect(pk.userHandle).toBe(c.expected.userHandle);
    }
  });
});

// ---------------------------------------------------------------------------
// buildInstallPasskeyTool: tool definition, registration predicate, execute
// path (resolveInside + readPasskeyFile + CDP ceremony), teardown.
// ---------------------------------------------------------------------------

interface DriverCalls {
  openSession: number;
  addAuth: VirtualAuthenticatorOptions[];
  addCred: Array<{ authenticatorId: string; credential: PasskeyCredential }>;
  close: number;
}

type DriverFailPoint = "openSession" | "addAuth" | "addCred";

function makeDriver(failOn?: DriverFailPoint): {
  driver: WebAuthnDriver;
  calls: DriverCalls;
} {
  const calls: DriverCalls = { openSession: 0, addAuth: [], addCred: [], close: 0 };

  const driver: WebAuthnDriver = {
    async openSession() {
      if (failOn === "openSession") throw new Error("openSession failed");
      calls.openSession += 1;
      return {
        async addVirtualAuthenticator(options) {
          if (failOn === "addAuth") throw new Error("addAuth failed");
          calls.addAuth.push(options);
          return "virt-auth-id";
        },
        async addCredential(authenticatorId, credential) {
          if (failOn === "addCred") throw new Error("addCred failed");
          calls.addCred.push({ authenticatorId, credential });
        },
        close() { calls.close += 1; },
      };
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

// Creates `<tmp>/.gauntlet/context/<name>/passkey.json` for each name and
// returns the context root directory.
function setupContext(tmp: string, names: string[]): string {
  const root = join(tmp, ".gauntlet", "context");
  mkdirSync(root, { recursive: true });
  for (const n of names) {
    mkdirSync(join(root, n));
    writeFileSync(join(root, n, "passkey.json"), JSON.stringify(SAMPLE_PASSKEY));
  }
  return root;
}

describe("buildInstallPasskeyTool", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gauntlet-passkey-tool-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns null when contextRoot does not exist", () => {
    const root = join(tmp, ".gauntlet", "context");
    expect(buildInstallPasskeyTool(root, 0, makeDriver().driver)).toBeNull();
  });

  test("returns null when contextRoot is empty", () => {
    const root = join(tmp, ".gauntlet", "context");
    mkdirSync(root, { recursive: true });
    expect(buildInstallPasskeyTool(root, 0, makeDriver().driver)).toBeNull();
  });

  test("returns null when contextRoot is a file, not a directory", () => {
    const root = join(tmp, "notadir");
    writeFileSync(root, "x");
    expect(buildInstallPasskeyTool(root, 0, makeDriver().driver)).toBeNull();
  });

  test("registers when contextRoot is non-empty even without passkey.json files", () => {
    // Registration predicate: non-empty directory. The tool does NOT
    // scan for passkey.json — that's a behavior change from v1 and
    // honors spec §2.1's principle that the runner does not interpret
    // filenames. If the author has no passkeys, the agent sees the
    // tool but never calls it.
    const root = join(tmp, ".gauntlet", "context");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "alice.md"), "flat profile, no passkey");
    const tool = buildInstallPasskeyTool(root, 0, makeDriver().driver);
    expect(tool).not.toBeNull();
  });

  test("tool definition uses the new `path` parameter (not `name`)", () => {
    const root = setupContext(tmp, ["alice"]);
    const tool = buildInstallPasskeyTool(root, 0, makeDriver().driver)!;
    expect(tool.definition.name).toBe("install_passkey");
    const params = tool.definition.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.properties).toHaveProperty("path");
    expect(params.properties).not.toHaveProperty("name");
    expect(params.required).toEqual(["path"]);
  });

  test("tool description matches spec §3.4 verbatim (load-bearing prose)", () => {
    // This test guards the "after every navigate() and before any click
    // that triggers WebAuthn" clause. Ponder's field notes confirm the
    // agent learned the ordering from that exact sentence. Any edit to
    // the description must go through the spec amendment protocol
    // (spec §13) — if this test breaks, do not update the expected
    // string without updating the spec first.
    const root = setupContext(tmp, ["alice"]);
    const tool = buildInstallPasskeyTool(root, 0, makeDriver().driver)!;
    const expected =
      "Install a passkey credential into the browser's virtual authenticator, " +
      "reading the credential JSON from a file under the project's context " +
      "directory. The path is relative to .gauntlet/context/ (example: " +
      '"alice/passkey.json"). You must re-call this tool after every navigate() ' +
      "and before any click that triggers WebAuthn — Chrome clears virtual " +
      "authenticators on every same-target navigation, and the authenticator does " +
      "not survive. Calls are safe and cheap to repeat. The tool returns a " +
      "success message naming the rpId on success; on failure it returns an " +
      "error identifying the CDP step that failed.";
    expect(tool.definition.description).toBe(expected);
  });

  test("success path: opens session, adds authenticator, adds credential, logs install_passkey_ok without leaking secrets", async () => {
    const root = setupContext(tmp, ["matt"]);
    const { driver, calls } = makeDriver();
    const { logger, actions } = makeFakeLogger();
    const tool = buildInstallPasskeyTool(root, 0, driver, logger)!;

    const result = await tool.execute({ path: "matt/passkey.json" });
    expect(result.text).toContain("Installed passkey");
    expect(result.text).toContain("example.test");

    // Driver exercised exactly once.
    expect(calls.openSession).toBe(1);
    expect(calls.addAuth).toHaveLength(1);
    expect(calls.addAuth[0].protocol).toBe("ctap2");
    expect(calls.addAuth[0].transport).toBe("internal");
    expect(calls.addAuth[0].isUserVerified).toBe(true);
    expect(calls.addCred).toHaveLength(1);
    expect(calls.addCred[0].authenticatorId).toBe("virt-auth-id");

    // install_passkey_ok action log entry present, with sanitized context.
    const ok = actions.find((a) => a.action === "install_passkey_ok");
    expect(ok).toBeDefined();
    expect(ok!.params.path).toBe("matt/passkey.json");
    expect(ok!.params.rpId).toBe("example.test");
    expect(ok!.params.credentialIdLength).toBeGreaterThan(0);
    expect(ok!.params.privateKeyLength).toBeGreaterThan(0);
    // Sensitive bytes must never appear in the log.
    expect(JSON.stringify(ok!.params)).not.toContain(SAMPLE_PASSKEY.privateKey);
    expect(JSON.stringify(ok!.params)).not.toContain(SAMPLE_PASSKEY.credentialId);
  });

  test("each execute call fully rebuilds: closes prior session, opens fresh one", async () => {
    const root = setupContext(tmp, ["matt", "alice"]);
    const { driver, calls } = makeDriver();
    const tool = buildInstallPasskeyTool(root, 0, driver)!;

    await tool.execute({ path: "matt/passkey.json" });
    await tool.execute({ path: "alice/passkey.json" });
    await tool.execute({ path: "matt/passkey.json" });

    expect(calls.openSession).toBe(3);
    expect(calls.addAuth).toHaveLength(3);
    expect(calls.addCred).toHaveLength(3);
    // First two sessions were closed when their successors were opened.
    // The third is still alive until teardown.
    expect(calls.close).toBe(2);
  });

  test("missing path argument returns an error and logs validate_args failure", async () => {
    const root = setupContext(tmp, ["matt"]);
    const { driver, calls } = makeDriver();
    const { logger, actions } = makeFakeLogger();
    const tool = buildInstallPasskeyTool(root, 0, driver, logger)!;

    const missing = await tool.execute({});
    expect(missing.text.toLowerCase()).toContain("error");
    expect(missing.text.toLowerCase()).toContain("path");

    // Did not hit the driver.
    expect(calls.openSession).toBe(0);

    const failure = actions.find((a) => a.action === "install_passkey_failed");
    expect(failure).toBeDefined();
    expect(failure!.params.step).toBe("validate_args");
  });

  test("path that escapes contextRoot is rejected at resolve_path", async () => {
    const root = setupContext(tmp, ["matt"]);
    // Write a decoy outside the context root.
    writeFileSync(join(tmp, "secret.json"), JSON.stringify(SAMPLE_PASSKEY));
    const { driver, calls } = makeDriver();
    const { logger, actions } = makeFakeLogger();
    const tool = buildInstallPasskeyTool(root, 0, driver, logger)!;

    const escape = await tool.execute({ path: "../secret.json" });
    expect(escape.text.toLowerCase()).toContain("error");

    expect(calls.openSession).toBe(0);
    const failure = actions.find((a) => a.action === "install_passkey_failed");
    expect(failure).toBeDefined();
    expect(failure!.params.step).toBe("resolve_path");
  });

  test("absolute path is rejected at resolve_path", async () => {
    const root = setupContext(tmp, ["matt"]);
    const { driver, calls } = makeDriver();
    const { logger, actions } = makeFakeLogger();
    const tool = buildInstallPasskeyTool(root, 0, driver, logger)!;

    const abs = await tool.execute({ path: join(root, "matt", "passkey.json") });
    expect(abs.text.toLowerCase()).toContain("error");
    expect(calls.openSession).toBe(0);
    const failure = actions.find((a) => a.action === "install_passkey_failed");
    expect(failure).toBeDefined();
    expect(failure!.params.step).toBe("resolve_path");
  });

  test("path pointing at a non-existent file surfaces as read_passkey error", async () => {
    const root = setupContext(tmp, ["matt"]);
    const { driver, calls } = makeDriver();
    const { logger, actions } = makeFakeLogger();
    const tool = buildInstallPasskeyTool(root, 0, driver, logger)!;

    const ghost = await tool.execute({ path: "ghost/passkey.json" });
    expect(ghost.text.toLowerCase()).toContain("error");
    expect(calls.openSession).toBe(0);
    const failure = actions.find((a) => a.action === "install_passkey_failed");
    expect(failure).toBeDefined();
    expect(failure!.params.step).toBe("read_passkey");
  });

  test("driver failures at each step surface as step-labeled errors and install_passkey_failed logs", async () => {
    const root = setupContext(tmp, ["matt"]);

    for (const { failOn, expectedStep } of [
      { failOn: "openSession" as const, expectedStep: "open_session" },
      { failOn: "addAuth" as const, expectedStep: "add_virtual_authenticator" },
      { failOn: "addCred" as const, expectedStep: "add_credential" },
    ]) {
      const { driver } = makeDriver(failOn);
      const { logger, actions } = makeFakeLogger();
      const tool = buildInstallPasskeyTool(root, 0, driver, logger)!;

      const result = await tool.execute({ path: "matt/passkey.json" });
      expect(result.text.toLowerCase()).toContain("error");
      expect(result.text).toContain(expectedStep);
      expect(result.text).toContain(`${failOn} failed`);

      const failure = actions.find((a) => a.action === "install_passkey_failed");
      expect(failure).toBeDefined();
      expect(failure!.params.step).toBe(expectedStep);
      expect(failure!.params.error).toBe(`${failOn} failed`);
      // Sensitive bytes never in the failure log either.
      expect(JSON.stringify(failure!.params)).not.toContain(SAMPLE_PASSKEY.privateKey);
    }
  });

  test("teardown closes the current session; no-op when nothing is open", async () => {
    const root = setupContext(tmp, ["matt"]);

    // No-op case.
    {
      const { driver, calls } = makeDriver();
      const tool = buildInstallPasskeyTool(root, 0, driver)!;
      await tool.teardown();
      expect(calls.openSession).toBe(0);
      expect(calls.close).toBe(0);
    }

    // Session-present case.
    {
      const { driver, calls } = makeDriver();
      const tool = buildInstallPasskeyTool(root, 0, driver)!;
      await tool.execute({ path: "matt/passkey.json" });
      await tool.teardown();
      expect(calls.close).toBe(1);
    }
  });
});
