import type { ToolDefinition, ToolResult } from "../models/provider";
import type { EvidenceLogger } from "../evidence/logger";
import {
  listPasskeyProfiles,
  readPasskey,
  type PasskeyCredential,
} from "../format/profile";

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

const DEFAULT_AUTHENTICATOR_OPTIONS: VirtualAuthenticatorOptions = {
  protocol: "ctap2",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
};

const TOOL_DESCRIPTION =
  "Install a passkey for a named profile. Must be re-called after every " +
  "navigate() and before any click that triggers WebAuthn — Chrome clears " +
  "virtual authenticators on navigation. Safe and cheap to repeat.";

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

const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export function buildInstallPasskeyTool(
  profilesDir: string,
  tab: number,
  driver: WebAuthnDriver,
  logger: EvidenceLogger | null = null,
): PasskeyTool | null {
  if (listPasskeyProfiles(profilesDir).length === 0) return null;

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
        name: {
          type: "string",
          description: "The profile name whose passkey should be installed into the browser session.",
        },
      },
      required: ["name"],
    },
  };

  const execute = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const available = () => listPasskeyProfiles(profilesDir);

    if (!name) {
      logger?.logAction("install_passkey_failed", {
        name: "", step: "validate_args", error: "missing name argument",
      });
      return {
        text: `Error: install_passkey requires a "name" argument. Available passkeys: ${available().join(", ") || "(none)"}`,
      };
    }

    let credential: PasskeyCredential;
    try {
      credential = readPasskey(profilesDir, name);
    } catch (err) {
      const error = errorMessage(err);
      logger?.logAction("install_passkey_failed", {
        name, step: "read_passkey", error, available: available(),
      });
      return { text: `Error: ${error}. Available passkeys: ${available().join(", ") || "(none)"}` };
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

      logger?.logAction("install_passkey_ok", {
        name, authenticatorId, ...credentialContext(credential),
      });
      return {
        text: `Installed passkey for "${name}" (rpId: ${credential.rpId}). The browser will now answer WebAuthn challenges for this credential until the next navigation.`,
      };
    } catch (err) {
      const error = errorMessage(err);
      logger?.logAction("install_passkey_failed", {
        name, step, error,
        authenticatorId,
        authenticatorOptions: DEFAULT_AUTHENTICATOR_OPTIONS,
        credential: credentialContext(credential),
      });
      return { text: `Error installing passkey for "${name}" at step "${step}": ${error}` };
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
