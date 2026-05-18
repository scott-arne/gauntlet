// We use `child_process` directly here rather than `src/runtime/spawn.ts`
// because the credential resolver needs a SIGTERM → grace → SIGKILL
// timeout cascade, and the existing seam's `kill()` doesn't take a
// signal. Every other caller in the codebase is fine with the seam;
// this module is the deliberate exception.
import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable } from "stream";
import type { CredentialResolverConfig } from "../config";
import { textResult, type ToolDefinition, type ToolResult } from "../models/provider";
import type { EvidenceLogger } from "../evidence/logger";
import { contextRootIsPopulated } from "../paths";

// `empty_stdout` is intentionally distinct from `ok`: per spec, a resolver
// that exits 0 but writes nothing is a failure mode the agent and operator
// need to see separately (agent: "resolver returned empty success"; action
// log step label: `empty_stdout`). Collapsing into `ok` would force the
// wrapper layer to reintroduce the distinction.
export type ResolverResult =
  | { kind: "ok"; stdout: string; stderr: string; exitCode: 0; elapsedMs: number }
  | { kind: "nonzero_exit"; stdout: string; stderr: string; exitCode: number; elapsedMs: number }
  | { kind: "empty_stdout"; stderr: string; exitCode: 0; elapsedMs: number }
  | { kind: "timeout"; stderr: string; timeoutMs: number; elapsedMs: number }
  | { kind: "spawn_failed"; error: string; elapsedMs: number }
  | { kind: "stdout_overflow"; elapsedMs: number }
  | { kind: "stderr_overflow"; elapsedMs: number };

const STDOUT_CAP_BYTES = 64 * 1024;
const STDERR_CAP_BYTES = 8 * 1024;
const KILL_GRACE_MS = 2_000;

export async function runResolver(
  config: CredentialResolverConfig,
  entity: string,
  key: string,
): Promise<ResolverResult> {
  const start = Date.now();
  // stdio: ["ignore", "pipe", "pipe"] narrows stdin to null and gives us
  // readable stdout/stderr — that's the precise ChildProcessByStdio variant.
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(config.path, [entity, key], {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return { kind: "spawn_failed", error: (err as Error).message, elapsedMs: Date.now() - start };
  }

  return new Promise<ResolverResult>((resolveOutcome) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let timedOut = false;
    let settled = false;

    const settle = (result: ResolverResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(killHandle);
      resolveOutcome(result);
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
    }, config.timeoutMs);

    const killHandle = setTimeout(() => {
      if (!settled) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }, config.timeoutMs + KILL_GRACE_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutOverflow) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > STDOUT_CAP_BYTES) {
        stdoutOverflow = true;
        try { child.kill("SIGKILL"); } catch {}
        settle({ kind: "stdout_overflow", elapsedMs: Date.now() - start });
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrOverflow) return;
      stderrBytes += chunk.length;
      if (stderrBytes > STDERR_CAP_BYTES) {
        stderrOverflow = true;
        try { child.kill("SIGKILL"); } catch {}
        settle({ kind: "stderr_overflow", elapsedMs: Date.now() - start });
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      settle({ kind: "spawn_failed", error: err.message, elapsedMs: Date.now() - start });
    });

    child.on("exit", (code) => {
      if (settled) return;
      const elapsedMs = Date.now() - start;
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (timedOut) {
        settle({ kind: "timeout", stderr, timeoutMs: config.timeoutMs, elapsedMs });
        return;
      }
      if (code !== 0) {
        settle({ kind: "nonzero_exit", stdout, stderr, exitCode: code ?? -1, elapsedMs });
        return;
      }
      if (stdout.length === 0) {
        settle({ kind: "empty_stdout", stderr, exitCode: 0, elapsedMs });
        return;
      }
      settle({ kind: "ok", stdout, stderr, exitCode: 0, elapsedMs });
    });
  });
}

export const FETCH_CREDENTIAL_TOOL_DESCRIPTION =
  "Fetch an ephemeral credential (OTP, invite code, magic link, verification code, " +
  "or other single-use or rotating secret) for a given entity. Use this for any " +
  "credential that cannot be written into a static fixture file because it " +
  "rotates, expires, or is single-use. The first argument `entity` is the " +
  "identifier for the user being acted as — typically the username or email, " +
  "whichever the system-under-test recognizes; extract it from the context file " +
  "that describes the user (use the `read` tool to fetch that file first). The " +
  "second argument `key` names which credential is being requested (e.g. \"otp\", " +
  "\"signup_verification\"). The file under .gauntlet/context/ that describes " +
  "the entity declares which `key` values are valid. Returns the credential's " +
  "current value as markdown; on failure returns an error message naming the " +
  "step that failed.";

export interface FetchCredentialTool {
  definition: ToolDefinition;
  // Logger is per-call rather than captured at construction so the
  // adapter-agnostic builder works equally well from web/cli/tui
  // adapters, each of which receives a per-tool-call logger in its
  // own executeTool(name, args, logger) entry point.
  execute(
    args: Record<string, unknown>,
    logger?: EvidenceLogger | null,
  ): Promise<ToolResult>;
}

const ENTITY_FORBIDDEN_PATTERN = /[\/\\]/;
const KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const ENTITY_MAX_LENGTH = 256;

function validateEntity(entity: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof entity !== "string" || entity.length === 0) {
    return { ok: false, reason: "must be a non-empty string" };
  }
  if (entity.length > ENTITY_MAX_LENGTH) {
    return { ok: false, reason: `must be ${ENTITY_MAX_LENGTH} characters or fewer` };
  }
  if (entity.startsWith(".")) {
    return { ok: false, reason: "must not start with '.'" };
  }
  if (entity.includes("..")) {
    return { ok: false, reason: "must not contain '..'" };
  }
  if (ENTITY_FORBIDDEN_PATTERN.test(entity)) {
    return { ok: false, reason: "must not contain '/' or '\\'" };
  }
  return { ok: true, value: entity };
}

function validateKey(key: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof key !== "string" || key.length === 0) {
    return { ok: false, reason: "must be a non-empty string" };
  }
  if (!KEY_PATTERN.test(key)) {
    return { ok: false, reason: "must match /^[a-zA-Z0-9_-]{1,64}$/" };
  }
  return { ok: true, value: key };
}

export function buildFetchCredentialTool(
  contextRoot: string,
  resolverConfig: CredentialResolverConfig | undefined,
): FetchCredentialTool | null {
  if (!resolverConfig) return null;
  if (!contextRootIsPopulated(contextRoot)) return null;

  const definition: ToolDefinition = {
    name: "fetch_credential",
    description: FETCH_CREDENTIAL_TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          description:
            "Identifier for the user being acted as, extracted from a context file (e.g. 'alice', 'alice@example.com').",
        },
        key: {
          type: "string",
          description:
            "Name of the ephemeral credential requested (e.g. 'otp', 'signup_verification'). The entity's context file lists the valid keys.",
        },
      },
      required: ["entity", "key"],
    },
  };

  const execute = async (
    args: Record<string, unknown>,
    logger: EvidenceLogger | null = null,
  ): Promise<ToolResult> => {
    const entityValidation = validateEntity(args.entity);
    if (!entityValidation.ok) {
      const reason = entityValidation.reason;
      logger?.logEvent("fetch_credential_failed", {
        entity: typeof args.entity === "string" ? args.entity.slice(0, 64) : "",
        key: typeof args.key === "string" ? args.key.slice(0, 64) : "",
        step: "validate_args",
        error: `entity ${reason}`,
      });
      return textResult(`Error: fetch_credential argument "entity" rejected: ${reason}.`);
    }
    const keyValidation = validateKey(args.key);
    if (!keyValidation.ok) {
      const reason = keyValidation.reason;
      logger?.logEvent("fetch_credential_failed", {
        entity: entityValidation.value,
        key: typeof args.key === "string" ? args.key.slice(0, 64) : "",
        step: "validate_args",
        error: `key ${reason}`,
      });
      return textResult(`Error: fetch_credential argument "key" rejected: ${reason}.`);
    }

    const entity = entityValidation.value;
    const key = keyValidation.value;
    const result = await runResolver(resolverConfig, entity, key);

    switch (result.kind) {
      case "ok":
        logger?.logEvent("fetch_credential_ok", {
          entity, key,
          exitCode: 0,
          stdoutLength: result.stdout.length,
          stderrLength: result.stderr.length,
          elapsedMs: result.elapsedMs,
        });
        // The agent's live context gets the full stdout (it needs to type
        // the value). The transcript (run.jsonl) gets a redacted marker
        // by default; the opt-in env var keeps the raw bytes.
        if (resolverConfig.includeInTranscripts) {
          return textResult(result.stdout);
        }
        return textResult(result.stdout, {
          transcriptText: `<credential redacted: entity=${entity} key=${key} len=${result.stdout.length}>`,
        });
      case "nonzero_exit":
        logger?.logEvent("fetch_credential_failed", {
          entity, key, step: "nonzero_exit",
          exitCode: result.exitCode,
          stdoutLength: result.stdout.length,
          stderrLength: result.stderr.length,
          elapsedMs: result.elapsedMs,
        });
        return textResult(`Error: fetch_credential resolver exited ${result.exitCode} for ${entity}:${key}:\n${result.stderr}`);
      case "empty_stdout":
        logger?.logEvent("fetch_credential_failed", {
          entity, key, step: "empty_stdout",
          stderrLength: result.stderr.length,
          elapsedMs: result.elapsedMs,
        });
        return textResult(`Error: fetch_credential resolver returned empty success for ${entity}:${key}.`);
      case "timeout":
        logger?.logEvent("fetch_credential_failed", {
          entity, key, step: "timeout",
          timeoutMs: result.timeoutMs,
          stderrLength: result.stderr.length,
          elapsedMs: result.elapsedMs,
        });
        return textResult(`Error: fetch_credential resolver timed out after ${result.timeoutMs}ms for ${entity}:${key}.`);
      case "stdout_overflow":
        logger?.logEvent("fetch_credential_failed", {
          entity, key, step: "stdout_overflow",
          elapsedMs: result.elapsedMs,
        });
        return textResult(`Error: fetch_credential resolver stdout exceeded 64 KiB for ${entity}:${key}.`);
      case "stderr_overflow":
        logger?.logEvent("fetch_credential_failed", {
          entity, key, step: "stderr_overflow",
          elapsedMs: result.elapsedMs,
        });
        return textResult(`Error: fetch_credential resolver stderr exceeded 8 KiB for ${entity}:${key}.`);
      case "spawn_failed":
        logger?.logEvent("fetch_credential_failed", {
          entity, key, step: "spawn",
          error: result.error,
        });
        return textResult(`Error: fetch_credential resolver failed to spawn: ${result.error}.`);
    }
  };

  return { definition, execute };
}
