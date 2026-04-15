import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildInstallPasskeyTool,
  type WebAuthnDriver,
  type WebAuthnSession,
  type VirtualAuthenticatorOptions,
} from "../../src/adapters/passkey-tool";
import type { PasskeyCredential } from "../../src/format/profile";
import type { EvidenceLogger } from "../../src/evidence/logger";

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
    logAction(action: string, params: Record<string, unknown>) {
      actions.push({ action, params });
    },
  } as unknown as EvidenceLogger;
  return { logger, actions };
}

function setupProfiles(tmp: string, names: string[]): string {
  const dir = join(tmp, "profiles");
  mkdirSync(dir);
  for (const n of names) {
    mkdirSync(join(dir, n));
    writeFileSync(join(dir, n, "passkey.json"), JSON.stringify(SAMPLE_PASSKEY));
  }
  return dir;
}

describe("buildInstallPasskeyTool", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gauntlet-passkey-tool-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns null when no passkey files exist", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    expect(buildInstallPasskeyTool(dir, 0, makeDriver().driver)).toBeNull();
  });

  test("returns an install_passkey tool with a free-form name parameter (no enum)", () => {
    const dir = setupProfiles(tmp, ["matt"]);
    const tool = buildInstallPasskeyTool(dir, 0, makeDriver().driver)!;
    expect(tool.definition.name).toBe("install_passkey");
    const params = tool.definition.parameters as {
      properties: { name: { enum?: unknown } };
    };
    expect(params.properties.name.enum).toBeUndefined();
  });

  test("success path: opens session, adds authenticator, adds credential, logs install_passkey_ok without leaking secrets", async () => {
    const dir = setupProfiles(tmp, ["matt"]);
    const { driver, calls } = makeDriver();
    const { logger, actions } = makeFakeLogger();
    const tool = buildInstallPasskeyTool(dir, 0, driver, logger)!;

    const result = await tool.execute({ name: "matt" });
    expect(result.text).toContain("Installed passkey for");
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
    expect(ok!.params.name).toBe("matt");
    expect(ok!.params.rpId).toBe("example.test");
    expect(ok!.params.credentialIdLength).toBeGreaterThan(0);
    expect(ok!.params.privateKeyLength).toBeGreaterThan(0);
    // Sensitive bytes must never appear in the log.
    expect(JSON.stringify(ok!.params)).not.toContain(SAMPLE_PASSKEY.privateKey);
    expect(JSON.stringify(ok!.params)).not.toContain(SAMPLE_PASSKEY.credentialId);
  });

  test("each execute call fully rebuilds: closes prior session, opens fresh one", async () => {
    const dir = setupProfiles(tmp, ["matt", "alice"]);
    const { driver, calls } = makeDriver();
    const tool = buildInstallPasskeyTool(dir, 0, driver)!;

    await tool.execute({ name: "matt" });
    await tool.execute({ name: "alice" });
    await tool.execute({ name: "matt" });

    expect(calls.openSession).toBe(3);
    expect(calls.addAuth).toHaveLength(3);
    expect(calls.addCred).toHaveLength(3);
    // First two sessions were closed when their successors were opened.
    // The third is still alive until teardown.
    expect(calls.close).toBe(2);
  });

  test("missing or unknown name returns an error listing available passkeys", async () => {
    const dir = setupProfiles(tmp, ["matt", "alice"]);
    const { driver, calls } = makeDriver();
    const { logger, actions } = makeFakeLogger();
    const tool = buildInstallPasskeyTool(dir, 0, driver, logger)!;

    // No name argument.
    const missing = await tool.execute({});
    expect(missing.text.toLowerCase()).toContain("error");
    expect(missing.text).toContain("alice");
    expect(missing.text).toContain("matt");

    // Unknown profile name.
    const ghost = await tool.execute({ name: "ghost" });
    expect(ghost.text.toLowerCase()).toContain("error");
    expect(ghost.text).toContain("alice");
    expect(ghost.text).toContain("matt");

    // Neither code path hit the driver.
    expect(calls.openSession).toBe(0);

    // Both paths log install_passkey_failed with distinct steps.
    const failures = actions.filter((a) => a.action === "install_passkey_failed");
    expect(failures).toHaveLength(2);
    expect(failures[0].params.step).toBe("validate_args");
    expect(failures[1].params.step).toBe("read_passkey");
  });

  test("driver failures at each step surface as step-labeled errors and install_passkey_failed logs", async () => {
    const dir = setupProfiles(tmp, ["matt"]);

    for (const { failOn, expectedStep } of [
      { failOn: "openSession" as const, expectedStep: "open_session" },
      { failOn: "addAuth" as const, expectedStep: "add_virtual_authenticator" },
      { failOn: "addCred" as const, expectedStep: "add_credential" },
    ]) {
      const { driver } = makeDriver(failOn);
      const { logger, actions } = makeFakeLogger();
      const tool = buildInstallPasskeyTool(dir, 0, driver, logger)!;

      const result = await tool.execute({ name: "matt" });
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
    const dir = setupProfiles(tmp, ["matt"]);

    // No-op case.
    {
      const { driver, calls } = makeDriver();
      const tool = buildInstallPasskeyTool(dir, 0, driver)!;
      await tool.teardown();
      expect(calls.openSession).toBe(0);
      expect(calls.close).toBe(0);
    }

    // Session-present case.
    {
      const { driver, calls } = makeDriver();
      const tool = buildInstallPasskeyTool(dir, 0, driver)!;
      await tool.execute({ name: "matt" });
      await tool.teardown();
      expect(calls.close).toBe(1);
    }
  });
});
