import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve as resolvePath } from "path";

export function listProfiles(dir: string): string[] {
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".md") && !entry.startsWith("."))
    .map((entry) => entry.slice(0, -3))
    .filter((name) => name.length > 0)
    .sort();
}

export function readProfile(dir: string, name: string): string {
  if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    throw new Error(`profile "${name}" not found`);
  }
  const filePath = join(dir, `${name}.md`);
  const dirAbs = resolvePath(dir);
  const fileAbs = resolvePath(filePath);
  if (fileAbs !== dirAbs && !fileAbs.startsWith(dirAbs + "/")) {
    throw new Error(`profile "${name}" not found`);
  }
  return readFileSync(filePath, "utf-8");
}

export function listPasskeyProfiles(dir: string): string[] {
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  return readdirSync(dir)
    .filter((entry) => !entry.startsWith("."))
    .filter((entry) => {
      const passkeyPath = join(dir, entry, "passkey.json");
      try {
        return statSync(passkeyPath).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

export interface PasskeyCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
}

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

export function readPasskey(dir: string, name: string): PasskeyCredential {
  if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    throw new Error(`passkey for "${name}" not found`);
  }
  const filePath = join(dir, name, "passkey.json");
  const dirAbs = resolvePath(dir);
  const fileAbs = resolvePath(filePath);
  if (!fileAbs.startsWith(dirAbs + "/")) {
    throw new Error(`passkey for "${name}" not found`);
  }
  const raw = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `passkey for "${name}": invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`passkey for "${name}": expected a JSON object`);
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.credentialId !== "string" || !p.credentialId) {
    throw new Error(`passkey for "${name}": missing or invalid credentialId`);
  }
  if (typeof p.rpId !== "string" || !p.rpId) {
    throw new Error(`passkey for "${name}": missing or invalid rpId`);
  }
  if (typeof p.privateKey !== "string" || !p.privateKey) {
    throw new Error(`passkey for "${name}": missing or invalid privateKey`);
  }
  if (typeof p.signCount !== "number") {
    throw new Error(`passkey for "${name}": missing or invalid signCount (must be an integer)`);
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
