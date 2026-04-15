import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listProfiles,
  readProfile,
  listPasskeyProfiles,
  readPasskey,
} from "../../src/format/profile";

// Synthetic fixture — not a real credential. rpId uses the reserved
// .test TLD so it can never collide with a live site. The three byte
// fields are standard base64 with padding (clean, nothing for the
// normalizer to do) so the "parses a valid passkey JSON" test can
// compare input and output directly.
const SAMPLE_PASSKEY = {
  credentialId: "VEVTVENSRURFTlRJQUxJRHh4eHh4eHh4eHg=",
  isResidentCredential: true,
  rpId: "example.test",
  userHandle: "VEVTVFVTRVJIQU5ETEV4eHh4eHg=",
  signCount: 0,
  privateKey: "VEVTVFBSSVZBVEVLRVl4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg=",
};

describe("listProfiles", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gauntlet-profiles-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns [] when directory is missing", () => {
    expect(listProfiles(join(tmp, "nonexistent"))).toEqual([]);
  });

  test("returns [] when directory is empty", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    expect(listProfiles(dir)).toEqual([]);
  });

  test("returns [] when path is a file, not a directory", () => {
    const p = join(tmp, "notadir");
    writeFileSync(p, "x");
    expect(listProfiles(p)).toEqual([]);
  });

  test("returns sorted aliases, stripping .md extension", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    writeFileSync(join(dir, "bob.md"), "");
    writeFileSync(join(dir, "alice.md"), "");
    writeFileSync(join(dir, "power-user.md"), "");
    expect(listProfiles(dir)).toEqual(["alice", "bob", "power-user"]);
  });

  test("ignores non-markdown and hidden files", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    writeFileSync(join(dir, "alice.md"), "");
    writeFileSync(join(dir, "README.txt"), "");
    writeFileSync(join(dir, ".gitignore"), "*.log");
    writeFileSync(join(dir, ".hidden.md"), "");
    expect(listProfiles(dir)).toEqual(["alice"]);
  });
});

describe("readProfile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gauntlet-profiles-read-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns the file contents verbatim", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    const body = `---\ndisplay_name: Alice\n---\n\n## Credentials\n\n- Username: alice@example.com\n- Password: hunter2\n`;
    writeFileSync(join(dir, "alice.md"), body);
    const contents = readProfile(dir, "alice");
    expect(contents).toBe(body);
  });

  test("throws when the named profile does not exist", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    writeFileSync(join(dir, "alice.md"), "A");
    expect(() => readProfile(dir, "bob")).toThrow();
  });

  test("rejects names that would escape the profiles directory", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    writeFileSync(join(tmp, "secret.md"), "nope");
    expect(() => readProfile(dir, "../secret")).toThrow();
  });

  test("rejects names with path separators", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "alice.md"), "inner");
    expect(() => readProfile(dir, "sub/alice")).toThrow();
  });
});

describe("listPasskeyProfiles", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gauntlet-passkey-list-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns [] when directory is missing", () => {
    expect(listPasskeyProfiles(join(tmp, "nonexistent"))).toEqual([]);
  });

  test("returns [] when directory has no subdirs with passkey.json", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    writeFileSync(join(dir, "alice.md"), "body");
    mkdirSync(join(dir, "bob"));
    writeFileSync(join(dir, "bob", "README.md"), "body");
    expect(listPasskeyProfiles(dir)).toEqual([]);
  });

  test("returns names of subdirs that contain passkey.json", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    mkdirSync(join(dir, "matt"));
    writeFileSync(join(dir, "matt", "passkey.json"), JSON.stringify(SAMPLE_PASSKEY));
    mkdirSync(join(dir, "alice"));
    writeFileSync(join(dir, "alice", "passkey.json"), JSON.stringify(SAMPLE_PASSKEY));
    mkdirSync(join(dir, "bob"));
    writeFileSync(join(dir, "bob", "README.md"), "no passkey here");
    expect(listPasskeyProfiles(dir)).toEqual(["alice", "matt"]);
  });

  test("coexists with flat markdown profiles", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    writeFileSync(join(dir, "alice.md"), "flat");
    mkdirSync(join(dir, "matt"));
    writeFileSync(join(dir, "matt", "passkey.json"), JSON.stringify(SAMPLE_PASSKEY));
    expect(listProfiles(dir)).toEqual(["alice"]);
    expect(listPasskeyProfiles(dir)).toEqual(["matt"]);
  });
});

describe("readPasskey", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gauntlet-passkey-read-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("parses a valid passkey JSON", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    mkdirSync(join(dir, "matt"));
    writeFileSync(join(dir, "matt", "passkey.json"), JSON.stringify(SAMPLE_PASSKEY));
    const pk = readPasskey(dir, "matt");
    expect(pk.credentialId).toBe(SAMPLE_PASSKEY.credentialId);
    expect(pk.rpId).toBe("example.test");
    expect(pk.isResidentCredential).toBe(true);
    expect(pk.privateKey).toBe(SAMPLE_PASSKEY.privateKey);
    expect(pk.userHandle).toBe(SAMPLE_PASSKEY.userHandle);
    expect(pk.signCount).toBe(0);
  });

  test("throws when the passkey file does not exist", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    expect(() => readPasskey(dir, "ghost")).toThrow();
  });

  test("throws when the JSON is malformed", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    mkdirSync(join(dir, "bad"));
    writeFileSync(join(dir, "bad", "passkey.json"), "{not json");
    expect(() => readPasskey(dir, "bad")).toThrow(/invalid JSON/);
  });

  test("throws when required fields are missing", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    mkdirSync(join(dir, "partial"));
    writeFileSync(
      join(dir, "partial", "passkey.json"),
      JSON.stringify({ credentialId: "x", rpId: "example.com" }),
    );
    expect(() => readPasskey(dir, "partial")).toThrow(/privateKey/);
  });

  test("throws when signCount is missing (CDP requires integer)", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    mkdirSync(join(dir, "nocount"));
    writeFileSync(
      join(dir, "nocount", "passkey.json"),
      JSON.stringify({
        credentialId: "x",
        rpId: "example.test",
        privateKey: "k",
      }),
    );
    expect(() => readPasskey(dir, "nocount")).toThrow(/signCount/);
  });

  test("normalizes byte fields to standard base64 with padding", () => {
    // CDP's WebAuthn.addCredential expects standard base64 with padding
    // (confirmed against Chrome 147), despite the protocol docs saying
    // base64url. readPasskey normalizes: `-` → `+`, `_` → `/`, then pads
    // to a multiple of 4. Already-standard inputs pass through unchanged.
    //
    // Chosen lengths hit every padding arm:
    //   10 chars → mod 4 == 2 → 2 pad chars
    //   11 chars → mod 4 == 3 → 1 pad char
    //   12 chars → mod 4 == 0 → no pad
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
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
      mkdirSync(join(dir, c.name));
      writeFileSync(join(dir, c.name, "passkey.json"), JSON.stringify(c.json));
      const pk = readPasskey(dir, c.name);
      expect(pk.credentialId).toBe(c.expected.credentialId);
      expect(pk.privateKey).toBe(c.expected.privateKey);
      expect(pk.userHandle).toBe(c.expected.userHandle);
    }
  });

  test("rejects path-escape names", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    writeFileSync(join(tmp, "secret.json"), "nope");
    expect(() => readPasskey(dir, "../secret")).toThrow();
  });
});
