import { readdirSync, readFileSync, statSync } from "fs";
import * as YAML from "yaml";
import type { ToolDefinition, ToolResult } from "../../models/provider";
import type { EvidenceLogger } from "../../evidence/logger";
import { resolveInside } from "../../paths";

// CDP CookieParam — the shape passed verbatim to `Network.setCookie`.
// Field set mirrors Chrome's protocol; we don't try to interpret cookie
// semantics ourselves (the spec author owns those, not the runner).
export interface CookieParam {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
  priority?: "Low" | "Medium" | "High";
  sameParty?: boolean;
  sourceScheme?: "Unset" | "NonSecure" | "Secure";
  sourcePort?: number;
}

// Per-cookie outcome from `Network.setCookie`. Mirrors what the
// chrome-ws-lib `setCookies` helper aggregates.
export interface SetCookieResult {
  name: string;
  success: boolean;
  errorReason?: string;
}

// Driver seam — lets the adapter swap in the real chrome-ws-lib helper
// while the tool's tests exercise it with a fake.
export interface CookiesDriver {
  setCookies(tab: number, cookies: CookieParam[]): Promise<SetCookieResult[]>;
}

// No teardown — cookies are browser state, not session-pinned CDP state.
// (Contrast install_passkey, where the virtual authenticator lives on
// the DevTools session that created it and must be torn down.)
export interface CookiesTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

// Tool description — authoritative prose from Gauntlet v1.5 spec §3.4.
// DO NOT edit without going through the amendment protocol (spec §13).
// The clauses "Call this once, before navigating to a cookie-gated
// origin", "Cookies persist across same-origin navigations", and "you
// must navigate again after installing" are load-bearing per §3.4's
// prose-break note — without them the agent does not understand the
// lifecycle difference from passkeys (which clear on every navigate).
const TOOL_DESCRIPTION =
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

// Allowed CDP CookieParam keys. Used for unknown-field rejection so a
// typo like `samesite` (lowercase) gets surfaced rather than silently
// dropped — Chrome would simply ignore the unknown key, leaving the
// agent to wonder why the cookie didn't behave as written.
const ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>([
  "name",
  "value",
  "url",
  "domain",
  "path",
  "secure",
  "httpOnly",
  "sameSite",
  "expires",
  "priority",
  "sameParty",
  "sourceScheme",
  "sourcePort",
]);

// Common case-mismatched typos for `sameSite`. Only `sameSite` gets a
// "did you mean" hint because it's the one with non-trivial casing the
// CDP expects (`samesite`/`SameSite`/`Samesite` are all the obvious
// mis-types). Everything else gets the generic "unknown field" message.
const SAMESITE_VARIANTS: ReadonlySet<string> = new Set<string>([
  "samesite",
  "Samesite",
  "SameSITE",
  "SAMESITE",
]);

function entryError(absolutePath: string, idx: number, msg: string): Error {
  return new Error(`cookies "${absolutePath}" entry ${idx}: ${msg}`);
}

// Reads and parses a list of cookies from an already-resolved absolute
// path. Path resolution + the context-root guard are the caller's job —
// use `resolveInside(contextRoot, relPath)` from src/paths.ts.
//
// Validation philosophy: catch typos and missing-required-field bugs
// here so the agent learns about them up front (instead of as a silent
// CDP rejection downstream). Cookie *semantics* — whether a `sameSite:
// None` cookie also has `secure: true`, whether `expires` is in the
// past, etc. — are Chrome's call, not ours.
export function readCookiesFile(absolutePath: string): CookieParam[] {
  const raw = readFileSync(absolutePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    // yaml's YAMLParseError already carries `linePos` in its message,
    // so surfacing the parser error verbatim gives the agent enough to
    // pinpoint the typo.
    throw new Error(
      `cookies "${absolutePath}": invalid YAML (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`cookies "${absolutePath}": expected a YAML list of cookie entries`);
  }

  const cookies: CookieParam[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw entryError(absolutePath, i, "expected a YAML mapping");
    }
    const e = entry as Record<string, unknown>;

    // Unknown-field check first, so typos surface ahead of missing-
    // required errors (a `samesite` typo on a complete-otherwise entry
    // is more informative than "missing sameSite" would be).
    for (const key of Object.keys(e)) {
      if (ALLOWED_FIELDS.has(key)) continue;
      if (SAMESITE_VARIANTS.has(key)) {
        throw entryError(absolutePath, i, `unknown field "${key}" (did you mean "sameSite"?)`);
      }
      throw entryError(absolutePath, i, `unknown field "${key}"`);
    }

    if (typeof e.name !== "string" || !e.name) {
      throw entryError(absolutePath, i, "missing or invalid `name`");
    }
    if (typeof e.value !== "string") {
      throw entryError(absolutePath, i, "missing or invalid `value` (must be a string)");
    }
    const hasUrl = typeof e.url === "string" && e.url.length > 0;
    const hasDomain = typeof e.domain === "string" && e.domain.length > 0;
    if (!hasUrl && !hasDomain) {
      throw entryError(
        absolutePath,
        i,
        "missing origin info — provide either `url` or `domain` (with optional `path`)",
      );
    }

    // Pass through verbatim; CDP owns cookie semantics. Cast via
    // `unknown` since the validated record doesn't structurally overlap
    // CookieParam from TypeScript's view (the optional fields could be
    // any unknown type pre-validation).
    cookies.push(e as unknown as CookieParam);
  }

  return cookies;
}

// Sanitized cookie metadata for the action log — never includes the
// cookie value bytes. valueLength is recorded so reviewers can sanity-
// check sizes without seeing secrets.
function cookieContext(cookie: CookieParam): Record<string, unknown> {
  return {
    name: cookie.name,
    domain: cookie.domain ?? null,
    url: cookie.url ?? null,
    path: cookie.path ?? null,
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
    sameSite: cookie.sameSite ?? null,
    valueLength: cookie.value.length,
  };
}

// Registration predicate: true when `contextRoot` exists, is a
// directory, and is non-empty. Matches `read` and `install_passkey`'s
// predicates; honors spec §2.1's principle that the runner does not
// interpret filenames. The runner never scans for `cookies.yaml` —
// if the author has no cookies, the agent sees the tool but never
// calls it.
//
// Duplicated from passkey.ts deliberately (per the plan's
// out-of-scope notes); a future refactor can lift this into
// src/paths.ts as a shared helper.
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

export function buildInstallCookiesTool(
  contextRoot: string,
  tab: number,
  driver: CookiesDriver,
  logger: EvidenceLogger | null = null,
): CookiesTool | null {
  if (!contextRootIsPopulated(contextRoot)) return null;

  const definition: ToolDefinition = {
    name: "install_cookies",
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the cookies YAML file, relative to .gauntlet/context/. Example: 'alice/cookies.yaml'.",
        },
      },
      required: ["path"],
    },
  };

  const execute = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const path = typeof args.path === "string" ? args.path.trim() : "";

    if (!path) {
      logger?.logEvent("install_cookies_failed", {
        path: "", step: "validate_args", error: "missing path argument",
      });
      return {
        text: `Error: install_cookies requires a "path" argument (relative to .gauntlet/context/).`,
      };
    }

    let resolved: string;
    try {
      resolved = resolveInside(contextRoot, path);
    } catch (err) {
      const error = errorMessage(err);
      logger?.logEvent("install_cookies_failed", {
        path, step: "resolve_path", error,
      });
      return { text: `Error: ${error}` };
    }

    let cookies: CookieParam[];
    try {
      cookies = readCookiesFile(resolved);
    } catch (err) {
      const error = errorMessage(err);
      logger?.logEvent("install_cookies_failed", {
        path, step: "read_cookies", error,
      });
      return { text: `Error: ${error}` };
    }

    let results: SetCookieResult[];
    try {
      results = await driver.setCookies(tab, cookies);
    } catch (err) {
      const error = errorMessage(err);
      logger?.logEvent("install_cookies_failed", {
        path,
        step: "set_cookies",
        error,
        cookies: cookies.map(cookieContext),
      });
      return {
        text: `Error installing cookies from "${path}" at step "set_cookies": ${error}`,
      };
    }

    const accepted: string[] = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    for (const r of results) {
      if (r.success) {
        accepted.push(r.name);
      } else {
        rejected.push({
          name: r.name,
          reason: r.errorReason ?? "chrome rejected cookie (no detail provided)",
        });
      }
    }

    logger?.logEvent("install_cookies_ok", {
      path,
      accepted: accepted.length,
      rejected: rejected.length,
      cookies: cookies.map(cookieContext),
    });

    const total = cookies.length;
    const acceptedNames = accepted.join(", ");
    const rejectedSummary = rejected
      .map((r) => `${r.name} (${r.reason})`)
      .join(", ");

    let text: string;
    if (rejected.length === 0) {
      text = `Installed ${total} cookies (${path}). Accepted: ${acceptedNames}.`;
    } else if (accepted.length === 0) {
      text = `Installed 0/${total} cookies (${path}). Rejected: ${rejectedSummary}.`;
    } else {
      text = `Installed ${accepted.length}/${total} cookies (${path}). Accepted: ${acceptedNames}. Rejected: ${rejectedSummary}.`;
    }

    return { text };
  };

  return { definition, execute };
}
