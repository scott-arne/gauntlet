import { readdirSync, readFileSync, statSync } from "fs";
import type { ToolDefinition, ToolResult } from "../../models/provider";
import type { EvidenceLogger } from "../../evidence/logger";
import { resolveInside } from "../../paths";

// A pinned CDP session with WebAuthn enabled. Bypasses the chrome-ws-lib
// connection pool so that every WebAuthn operation rides the same
// WebSocket — required because virtual authenticators live on the
// DevTools session that created them.
export interface WebAuthnSession {
  addVirtualAuthenticator(options: VirtualAuthenticatorOptions): Promise<string>;
  addCredential(authenticatorId: string, credential: PasskeyCredential): Promise<void>;
  close(): void | Promise<void>;
}

export interface WebAuthnDriver {
  openSession(tab: number): Promise<WebAuthnSession>;
}

export interface VirtualAuthenticatorOptions {
  protocol: "ctap2" | "u2f";
  transport: "usb" | "nfc" | "ble" | "internal";
  hasResidentKey: boolean;
  hasUserVerification: boolean;
  isUserVerified: boolean;
  automaticPresenceSimulation?: boolean;
}

export interface PasskeyTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
  teardown(): Promise<void>;
}

export interface PasskeyCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
}

const DEFAULT_AUTHENTICATOR_OPTIONS: VirtualAuthenticatorOptions = {
  protocol: "ctap2",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
};

// Tool description — authoritative prose from Gauntlet v1.5 spec §3.4.
// DO NOT edit without going through the amendment protocol (spec §13);
// Ponder's field notes confirm the agent learned the "after every
// navigate() and before any click that triggers WebAuthn" ordering from
// this exact sentence.
const TOOL_DESCRIPTION =
  "Install a passkey credential into the browser's virtual authenticator, " +
  "reading the credential JSON from a file under the project's context " +
  "directory. The path is relative to .gauntlet/context/ (example: " +
  '"alice/passkey.json"). You must re-call this tool after every navigate() ' +
  "and before any click that triggers WebAuthn — Chrome clears virtual " +
  "authenticators on every same-target navigation, and the authenticator does " +
  "not survive. Calls are safe and cheap to repeat. The tool returns a " +
  "success message naming the rpId on success; on failure it returns an " +
  "error identifying the CDP step that failed.";

// CDP's WebAuthn.addCredential, contrary to its protocol documentation
// (which says base64url), actually requires **standard base64 with padding**
// — verified against Chrome 147 by sending both variants. Base64url fields
// with `-` / `_` / no-padding get rejected as
// "Failed to deserialize params.credential.<field> - BINDINGS: invalid
// base64 string at position N". We normalize in the forward direction
// (base64url → standard base64, padding added) so callers can supply JSON
// in either encoding and the tool passes what Chrome actually expects.
function toStandardBase64(input: string): string {
  const cleaned = input.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const paddingNeeded = (4 - (cleaned.length % 4)) % 4;
  return cleaned + "=".repeat(paddingNeeded);
}

// Reads and parses a passkey credential from an already-resolved absolute
// path. Path resolution + the context-root guard are the caller's job —
// use `resolveInside(contextRoot, relPath)` from src/paths.ts.
export function readPasskeyFile(absolutePath: string): PasskeyCredential {
  const raw = readFileSync(absolutePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `passkey "${absolutePath}": invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`passkey "${absolutePath}": expected a JSON object`);
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.credentialId !== "string" || !p.credentialId) {
    throw new Error(`passkey "${absolutePath}": missing or invalid credentialId`);
  }
  if (typeof p.rpId !== "string" || !p.rpId) {
    throw new Error(`passkey "${absolutePath}": missing or invalid rpId`);
  }
  if (typeof p.privateKey !== "string" || !p.privateKey) {
    throw new Error(`passkey "${absolutePath}": missing or invalid privateKey`);
  }
  if (typeof p.signCount !== "number") {
    throw new Error(`passkey "${absolutePath}": missing or invalid signCount (must be an integer)`);
  }
  return {
    credentialId: toStandardBase64(p.credentialId),
    isResidentCredential: Boolean(p.isResidentCredential),
    rpId: p.rpId,
    privateKey: toStandardBase64(p.privateKey),
    userHandle:
      typeof p.userHandle === "string" ? toStandardBase64(p.userHandle) : undefined,
    signCount: p.signCount,
  };
}

// Sanitized credential metadata for the action log — lengths and
// non-secret fields only. Never include credentialId or privateKey bytes.
function credentialContext(credential: PasskeyCredential): Record<string, unknown> {
  return {
    rpId: credential.rpId,
    isResidentCredential: credential.isResidentCredential,
    signCount: credential.signCount,
    credentialIdLength: credential.credentialId.length,
    privateKeyLength: credential.privateKey.length,
    hasUserHandle: credential.userHandle !== undefined,
    userHandleLength: credential.userHandle?.length ?? 0,
  };
}

// Registration predicate: true when `contextRoot` exists, is a directory,
// and is non-empty. Matches the `read` tool's predicate and honors
// spec §2.1's principle that the runner does not interpret filenames.
// The runner never scans for `passkey.json` — if the author has no
// passkeys, the agent sees the tool in its registry but never calls it.
function contextRootIsPopulated(contextRoot: string): boolean {
  try {
    const stat = statSync(contextRoot);
    if (!stat.isDirectory()) return false;
    return readdirSync(contextRoot).length > 0;
  } catch {
    return false;
  }
}

const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export function buildInstallPasskeyTool(
  contextRoot: string,
  tab: number,
  driver: WebAuthnDriver,
  logger: EvidenceLogger | null = null,
): PasskeyTool | null {
  if (!contextRootIsPopulated(contextRoot)) return null;

  // The live session, if any. Replaced on every execute() call —
  // Chrome clears WebAuthn state on page navigation, so optimistic
  // reuse is unsafe. We only retain it so teardown() can close it.
  let session: WebAuthnSession | null = null;

  const definition: ToolDefinition = {
    name: "install_passkey",
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the passkey JSON file, relative to .gauntlet/context/. Example: 'alice/passkey.json'.",
        },
      },
      required: ["path"],
    },
  };

  const execute = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const path = typeof args.path === "string" ? args.path.trim() : "";

    if (!path) {
      logger?.logEvent("install_passkey_failed", {
        path: "", step: "validate_args", error: "missing path argument",
      });
      return {
        text: `Error: install_passkey requires a "path" argument (relative to .gauntlet/context/).`,
      };
    }

    let resolved: string;
    try {
      resolved = resolveInside(contextRoot, path);
    } catch (err) {
      const error = errorMessage(err);
      logger?.logEvent("install_passkey_failed", {
        path, step: "resolve_path", error,
      });
      return { text: `Error: ${error}` };
    }

    let credential: PasskeyCredential;
    try {
      credential = readPasskeyFile(resolved);
    } catch (err) {
      const error = errorMessage(err);
      logger?.logEvent("install_passkey_failed", {
        path, step: "read_passkey", error,
      });
      return { text: `Error: ${error}` };
    }

    // Close any prior session so the next ceremony starts clean. Prior
    // sessions may already be dead (Chrome reset the WebAuthn domain on
    // navigation); swallow errors.
    if (session) {
      try { await session.close(); } catch {}
      session = null;
    }

    let step = "open_session";
    let authenticatorId: string | null = null;
    try {
      session = await driver.openSession(tab);
      step = "add_virtual_authenticator";
      authenticatorId = await session.addVirtualAuthenticator(DEFAULT_AUTHENTICATOR_OPTIONS);
      step = "add_credential";
      await session.addCredential(authenticatorId, credential);

      logger?.logEvent("install_passkey_ok", {
        path, authenticatorId, ...credentialContext(credential),
      });
      return {
        text: `Installed passkey from "${path}" (rpId: ${credential.rpId}). The browser will now answer WebAuthn challenges for this credential until the next navigation.`,
      };
    } catch (err) {
      const error = errorMessage(err);
      logger?.logEvent("install_passkey_failed", {
        path, step, error,
        authenticatorId,
        authenticatorOptions: DEFAULT_AUTHENTICATOR_OPTIONS,
        credential: credentialContext(credential),
      });
      return { text: `Error installing passkey from "${path}" at step "${step}": ${error}` };
    }
  };

  const teardown = async (): Promise<void> => {
    const current = session;
    session = null;
    if (current) {
      try { await current.close(); } catch {}
    }
  };

  return { definition, execute, teardown };
}
