import { isAbsolute, resolve as resolvePath } from "node:path";
import { statSync } from "node:fs";
import { ADAPTER_TYPES, isAdapterType, type AdapterType } from "./adapters/adapter";
import { parseDuration } from "./util/parse-duration";
import { resolveSetting, resolveEnvOnlySetting } from "./config-helpers";

export interface ChromeEndpoint {
  host: string;
  port: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface CredentialResolverConfig {
  path: string;
  timeoutMs: number;
  includeInTranscripts: boolean;
}

export interface AppConfig {
  projectRoot: string;
  port: number;
  defaultChrome: ChromeEndpoint;
  /**
   * Default target URL, surfaced to the UI as a prefill for the New Run
   * form. Sourced from --target or GAUNTLET_TARGET. Undefined when the
   * operator did not supply one; in that case the UI leaves the field
   * blank.
   */
  defaultTarget?: string;
  /**
   * Wall-clock budget for an agent run in milliseconds. The agent loop
   * exits when `Date.now() >= deadline`. Default 300_000 (5 min); override
   * via `--max-time` or `GAUNTLET_MAX_TIME`.
   */
  defaultBudgetMs: number;
  /**
   * Number of LLM turns between reflection checkpoints. Every N turns
   * the agent loop appends a `<SYSTEM-REMINDER>` block with a literal
   * trace of recent mutating tool calls to the user message carrying
   * tool results. Default 10; set to 0 to disable. Not enforced — a
   * prompt nudge to recognize the agent's own loops.
   */
  defaultReflectionInterval: number;
  /**
   * Viewport applied to the browsing tab on web-adapter runs (via
   * `Emulation.setDeviceMetricsOverride`). Per-run overrides (request
   * body `viewport` or CLI `--viewport`) take precedence.
   */
  defaultViewport: Viewport;
  /**
   * When true, web-adapter runs persist each screencast frame to
   * `<runDir>/frames/`. Default is false: the live WebSocket stream to
   * watching UI clients is unaffected, but disk writes are skipped.
   * Screencast files are typically 100MB–1GB per run and are rarely
   * consulted post-run. Per-run override via body `saveScreencast` or
   * CLI `--save-screencast`.
   */
  defaultSaveScreencast: boolean;
  /**
   * Maximum time (ms) `gauntlet serve` waits for in-flight runs to
   * complete naturally after receiving SIGTERM/SIGINT/SIGHUP before
   * forcing exit. PRI-1477.
   */
  shutdownGraceMs: number;
  /**
   * Maximum HTTP request body size in bytes. Applied at the Bun.serve
   * level (413 Payload Too Large before the route handler). PRI-1478.
   */
  maxRequestBodySize: number;
  /**
   * Maximum number of in-flight runs the daemon will accept. POST
   * `/api/run` returns 429 with `Retry-After: 5` when at cap. PRI-1478.
   */
  maxConcurrentRuns: number;
  /**
   * Maximum length (bytes) of a `target` URL surfaced in the
   * `/api/runs/active` list payload. Targets longer than this are
   * truncated to `<MAX>...` in the list view; the per-run snapshot
   * endpoint still returns the full string. PRI-1478.
   */
  activeRunTargetMaxBytes: number;
  /**
   * Idle timeout (seconds) for WebSocket connections. Bun's
   * `websocket.idleTimeout` closes the socket if no messages flow in
   * either direction within this window. Defends against accumulating
   * dead WS subscribers. PRI-1483.
   */
  wsIdleTimeoutSec: number;
  /**
   * If non-empty, only accept WebSocket upgrades whose `Origin` header
   * matches one of these strings exactly. Defense-in-depth, opt-in via
   * `GAUNTLET_WS_ORIGIN_ALLOWLIST`. PRI-1483.
   */
  wsOriginAllowlist: string[];
  models: {
    agent: string;
    fanout?: string;
    available: string[];
  };
  apiKeys: {
    anthropic: boolean;
    openai: boolean;
  };
  /**
   * Caller-provided runtime credential resolver. When set, the
   * `fetch_credential` agent tool is registered and invokes this
   * executable per call with `<entity> <key>` as argv. Undefined when
   * GAUNTLET_CREDENTIAL_RESOLVER is unset. PRI-1605.
   */
  credentialResolver?: CredentialResolverConfig;
  sources: {
    projectRoot: "default" | "env" | "flag";
    port: "default" | "env" | "flag";
    defaultChrome: "default" | "env" | "flag";
    defaultTarget: "default" | "env" | "flag" | "unset";
    defaultBudgetMs: "default" | "env" | "flag";
    defaultReflectionInterval: "default" | "env" | "flag";
    defaultViewport: "default" | "env" | "flag";
    defaultSaveScreencast: "default" | "env" | "flag";
    shutdownGraceMs: "default" | "env";
    maxRequestBodySize: "default" | "env";
    maxConcurrentRuns: "default" | "env";
    activeRunTargetMaxBytes: "default" | "env";
    wsIdleTimeoutSec: "default" | "env";
    wsOriginAllowlist: "default" | "env";
    "models.agent": "default" | "env" | "flag";
    "models.fanout": "default" | "env" | "flag" | "unset";
    "models.available": "default" | "env" | "flag";
    credentialResolver: "default" | "env";
  };
}

export interface CliArgsInput {
  projectRoot?: string;
  port?: number;
  chrome?: string;
  target?: string;
  maxTime?: string;
  reflectionInterval?: number;
  viewport?: string;
  saveScreencast?: boolean;
  models?: { agent?: string; fanout?: string };
}

export interface RunRequestBody {
  target: string;
  model?: string;
  chrome?: string;
  adapter?: AdapterType;
  viewport?: Viewport;
  saveScreencast?: boolean;
  passes?: number;
}

export interface ResolvedRunConfig {
  target: string;
  model: string;
  /**
   * Undefined means: caller did not specify an endpoint and the server
   * config is at its default — let WebAdapter auto-launch a local Chrome.
   * A defined value means an explicit endpoint (from body, env, or flag).
   */
  chrome: ChromeEndpoint | undefined;
  adapter: AdapterType;
  viewport: Viewport;
  /**
   * Whether this run should persist screencast frames to disk. The live
   * WS stream to watching UI clients is always on regardless of this
   * flag; only the disk writer is gated.
   */
  saveScreencast: boolean;
  projectRoot: string;
  budgetMs: number;
  reflectionInterval: number;
  /**
   * Caller-provided credential resolver, threaded through from
   * AppConfig. Adapters use this to register the fetch_credential
   * tool when set. PRI-1605.
   */
  credentialResolver?: CredentialResolverConfig;
}

const RUN_BODY_ALLOWED = new Set(["target", "model", "chrome", "adapter", "viewport", "saveScreencast", "passes"]);
export const DEFAULT_BUDGET_MS = 300_000;
export const DEFAULT_REFLECTION_INTERVAL = 10;
export const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900 };

function parseViewportString(raw: string, label: string): Viewport {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(raw.trim());
  if (!match) {
    throw new Error(`Invalid ${label} "${raw}": expected WxH (e.g. 1440x900)`);
  }
  const width = parseInt(match[1], 10);
  const height = parseInt(match[2], 10);
  assertViewportBounds({ width, height }, label);
  return { width, height };
}

function assertViewportBounds(v: Viewport, label: string): void {
  if (!Number.isInteger(v.width) || v.width < 320 || v.width > 7680) {
    throw new Error(`Invalid ${label} width ${v.width}: must be an integer in [320, 7680]`);
  }
  if (!Number.isInteger(v.height) || v.height < 200 || v.height > 4320) {
    throw new Error(`Invalid ${label} height ${v.height}: must be an integer in [200, 4320]`);
  }
}

export function validateRunBody(body: unknown, opts: Record<string, never> = {}): RunRequestBody {
  if (!body || typeof body !== "object") {
    throw new Error("run request body must be an object");
  }
  const bodyObj = body as Record<string, unknown>;
  // Check for `turns` before the generic unknown-field gate so callers get
  // a targeted error instead of "unknown field: turns".
  if (bodyObj.turns !== undefined) {
    throw new Error(
      "run request body: field `turns` is no longer accepted; configure budget server-side via --max-time or GAUNTLET_MAX_TIME",
    );
  }
  const unknown = Object.keys(bodyObj).filter((k) => !RUN_BODY_ALLOWED.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown field${unknown.length > 1 ? "s" : ""} in run request body: ${unknown.join(", ")}. Allowed: ${[...RUN_BODY_ALLOWED].join(", ")}`,
    );
  }
  if (typeof bodyObj.target !== "string" || !bodyObj.target) {
    throw new Error("run request body: target is required and must be a non-empty string");
  }
  if (bodyObj.adapter !== undefined && !isAdapterType(bodyObj.adapter)) {
    throw new Error(
      `run request body: adapter must be one of: ${ADAPTER_TYPES.join(", ")}`,
    );
  }
  let viewport: Viewport | undefined;
  if (bodyObj.viewport !== undefined) {
    const v = bodyObj.viewport;
    if (!v || typeof v !== "object") {
      throw new Error("run request body: viewport must be an object with {width, height}");
    }
    const vObj = v as Record<string, unknown>;
    if (typeof vObj.width !== "number" || typeof vObj.height !== "number") {
      throw new Error("run request body: viewport.width and viewport.height must be numbers");
    }
    const candidate = { width: vObj.width, height: vObj.height };
    assertViewportBounds(candidate, "run request body: viewport");
    viewport = candidate;
  }
  let saveScreencast: boolean | undefined;
  if (bodyObj.saveScreencast !== undefined) {
    if (typeof bodyObj.saveScreencast !== "boolean") {
      throw new Error("run request body: saveScreencast must be a boolean");
    }
    saveScreencast = bodyObj.saveScreencast;
  }
  let passes: number | undefined;
  if (bodyObj.passes !== undefined) {
    if (!Number.isInteger(bodyObj.passes) || (bodyObj.passes as number) < 1 || (bodyObj.passes as number) > 50) {
      throw new Error("passes must be an integer in [1, 50]");
    }
    passes = bodyObj.passes as number;
  }
  return {
    target: bodyObj.target,
    model: typeof bodyObj.model === "string" ? bodyObj.model : undefined,
    chrome: typeof bodyObj.chrome === "string" ? bodyObj.chrome : undefined,
    adapter: bodyObj.adapter,
    viewport,
    saveScreencast,
    passes,
  };
}

export function mergeRunConfig(app: AppConfig, body: RunRequestBody): ResolvedRunConfig {
  // Precedence: explicit body > explicit server config (env/flag) > undefined (auto-launch).
  // Source attribution is the tiebreaker — if the user never specified a
  // chrome endpoint anywhere, leave it undefined so WebAdapter falls back
  // to its auto-launch path instead of trying to attach to the default
  // 127.0.0.1:9222 (which silently breaks plain `gauntlet run`).
  const chrome: ChromeEndpoint | undefined = body.chrome
    ? parseChromeEndpoint(body.chrome, "body.chrome")
    : app.sources.defaultChrome === "default"
      ? undefined
      : app.defaultChrome;
  return {
    target: body.target,
    model: body.model ?? app.models.agent,
    chrome,
    adapter: body.adapter ?? "web",
    viewport: body.viewport ?? app.defaultViewport,
    saveScreencast: body.saveScreencast ?? app.defaultSaveScreencast,
    projectRoot: app.projectRoot,
    budgetMs: app.defaultBudgetMs,
    reflectionInterval: app.defaultReflectionInterval,
    credentialResolver: app.credentialResolver,
  };
}

const DEFAULT_PROJECT_ROOT = ".";
const DEFAULT_PORT = 4400;
const DEFAULT_CHROME: ChromeEndpoint = { host: "127.0.0.1", port: 9222 };
const DEFAULT_SHUTDOWN_GRACE_MS = 10000;
const DEFAULT_MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1 MB
const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const DEFAULT_ACTIVE_RUN_TARGET_MAX_BYTES = 1024;
const DEFAULT_WS_IDLE_TIMEOUT_SEC = 60;
const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";
const DEFAULT_CREDENTIAL_RESOLVER_TIMEOUT_MS = 10_000;

function parseChromeEndpoint(raw: string, label: string): ChromeEndpoint {
  const idx = raw.lastIndexOf(":");
  if (idx === -1) {
    throw new Error(`Invalid ${label} "${raw}": expected "host:port" format`);
  }
  const host = raw.slice(0, idx);
  const portStr = raw.slice(idx + 1);
  if (!host || !portStr) {
    throw new Error(`Invalid ${label} "${raw}": expected "host:port" format`);
  }
  const port = parseInt(portStr, 10);
  if (Number.isNaN(port)) {
    throw new Error(`Invalid ${label} "${raw}": port "${portStr}" is not a number`);
  }
  return { host, port };
}

function parsePortNumber(raw: string, label: string): number {
  const port = parseInt(raw, 10);
  if (Number.isNaN(port)) {
    throw new Error(`Invalid ${label} "${raw}": not a number`);
  }
  return port;
}

/**
 * Parse a non-negative integer env var with a default fallback. Used by
 * the operator-level numeric knobs (PRI-1477, PRI-1478).
 */
function parseNonNegIntEnv(raw: string | undefined, label: string, fallback: number): number {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label} "${raw}": expected a non-negative integer`);
  }
  return parsed;
}

/**
 * Parse a boolean-ish env var. Accepts the usual affirmatives (1, true,
 * yes, on) and negatives (0, false, no, off); rejects anything else to
 * avoid "well I set it to 'maybe'..." surprises.
 */
function parseBoolEnv(raw: string, label: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off" || v === "") return false;
  throw new Error(`Invalid ${label} "${raw}": expected a boolean (1/0, true/false, yes/no, on/off)`);
}

function resolveCredentialResolver(
  rawPath: string,
  projectRoot: string,
): string {
  const absolute = isAbsolute(rawPath) ? rawPath : resolvePath(projectRoot, rawPath);
  let stat;
  try {
    stat = statSync(absolute);
  } catch (err) {
    throw new Error(
      `Invalid GAUNTLET_CREDENTIAL_RESOLVER "${rawPath}": cannot stat "${absolute}" (${(err as Error).message})`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `Invalid GAUNTLET_CREDENTIAL_RESOLVER "${rawPath}": "${absolute}" is not a regular file`,
    );
  }
  // Any execute bit set (owner, group, or other).
  if ((stat.mode & 0o111) === 0) {
    throw new Error(
      `Invalid GAUNTLET_CREDENTIAL_RESOLVER "${rawPath}": "${absolute}" is not executable (mode ${(stat.mode & 0o777).toString(8)})`,
    );
  }
  return absolute;
}

/**
 * Verify the loaded config has at least one LLM provider configured.
 * Called by `serve` and `run` dispatch; NOT called by `config` (which
 * needs to introspect broken environments without crashing).
 *
 * Throws a clean Error on failure. The SDK clients in src/models/*.ts
 * also throw if you construct them without a key — this is belt-and-
 * suspenders. The server-level throw here fails-fast at boot with a
 * clear message, instead of letting the first run fail mid-agent.
 */
export function requireLlmCapable(config: AppConfig): void {
  if (!config.apiKeys.anthropic && !config.apiKeys.openai) {
    throw new Error(
      "No LLM provider configured. Set ANTHROPIC_API_KEY (for Claude models) " +
      "or OPENAI_API_KEY (for GPT models). Run 'gauntlet config' to see current state.",
    );
  }
}

export function loadConfig(args: CliArgsInput, env: NodeJS.ProcessEnv): AppConfig {
  // projectRoot
  const projectRootR = resolveSetting({
    default: DEFAULT_PROJECT_ROOT,
    env: { name: "GAUNTLET_PROJECT_ROOT", parse: (s) => s },
    arg: { value: args.projectRoot },
  }, env);
  const projectRoot = projectRootR.value;
  const projectRootSource = projectRootR.source;

  // port
  let port = DEFAULT_PORT;
  let portSource: "default" | "env" | "flag" = "default";
  if (env.GAUNTLET_PORT) {
    port = parsePortNumber(env.GAUNTLET_PORT, "GAUNTLET_PORT");
    portSource = "env";
  }
  if (args.port !== undefined) {
    port = args.port;
    portSource = "flag";
  }

  // defaultChrome
  let defaultChrome: ChromeEndpoint = DEFAULT_CHROME;
  let chromeSource: "default" | "env" | "flag" = "default";
  if (env.GAUNTLET_CHROME) {
    defaultChrome = parseChromeEndpoint(env.GAUNTLET_CHROME, "GAUNTLET_CHROME");
    chromeSource = "env";
  }
  if (args.chrome !== undefined) {
    defaultChrome = parseChromeEndpoint(args.chrome, "--chrome");
    chromeSource = "flag";
  }

  // defaultTarget
  let defaultTarget: string | undefined;
  let targetSource: "default" | "env" | "flag" | "unset" = "unset";
  if (env.GAUNTLET_TARGET) {
    defaultTarget = env.GAUNTLET_TARGET;
    targetSource = "env";
  }
  if (args.target !== undefined) {
    defaultTarget = args.target;
    targetSource = "flag";
  }

  // defaultViewport
  let defaultViewport: Viewport = DEFAULT_VIEWPORT;
  let viewportSource: "default" | "env" | "flag" = "default";
  if (env.GAUNTLET_VIEWPORT) {
    defaultViewport = parseViewportString(env.GAUNTLET_VIEWPORT, "GAUNTLET_VIEWPORT");
    viewportSource = "env";
  }
  if (args.viewport !== undefined) {
    defaultViewport = parseViewportString(args.viewport, "--viewport");
    viewportSource = "flag";
  }

  // defaultSaveScreencast — opt-in persistence of screencast frames.
  // Defaults off because per-run screencast files are 100MB–1GB and
  // rarely consulted post-run; the live WS stream to UI clients is
  // unaffected either way.
  let defaultSaveScreencast = false;
  let saveScreencastSource: "default" | "env" | "flag" = "default";
  if (env.GAUNTLET_SAVE_SCREENCAST !== undefined) {
    defaultSaveScreencast = parseBoolEnv(env.GAUNTLET_SAVE_SCREENCAST, "GAUNTLET_SAVE_SCREENCAST");
    saveScreencastSource = "env";
  }
  if (args.saveScreencast !== undefined) {
    defaultSaveScreencast = args.saveScreencast;
    saveScreencastSource = "flag";
  }

  // defaultBudgetMs — wall-clock budget for the agent loop.
  let defaultBudgetMs = DEFAULT_BUDGET_MS;
  let budgetSource: "default" | "env" | "flag" = "default";
  if (env.GAUNTLET_MAX_TIME) {
    try {
      defaultBudgetMs = parseDuration(env.GAUNTLET_MAX_TIME);
    } catch (err) {
      throw new Error(`Invalid GAUNTLET_MAX_TIME "${env.GAUNTLET_MAX_TIME}": ${(err as Error).message}`);
    }
    budgetSource = "env";
  }
  if (args.maxTime !== undefined) {
    try {
      defaultBudgetMs = parseDuration(args.maxTime);
    } catch (err) {
      throw new Error(`Invalid --max-time "${args.maxTime}": ${(err as Error).message}`);
    }
    budgetSource = "flag";
  }

  // defaultReflectionInterval — turns between reflection checkpoints.
  // 0 disables. Prompt-only nudge, not enforced.
  let defaultReflectionInterval = DEFAULT_REFLECTION_INTERVAL;
  let reflectionSource: "default" | "env" | "flag" = "default";
  if (env.GAUNTLET_REFLECTION_INTERVAL) {
    const raw = env.GAUNTLET_REFLECTION_INTERVAL;
    if (!/^\d+$/.test(raw)) {
      throw new Error(`Invalid GAUNTLET_REFLECTION_INTERVAL "${raw}": expected non-negative integer (0 disables)`);
    }
    defaultReflectionInterval = parseInt(raw, 10);
    reflectionSource = "env";
  }
  if (args.reflectionInterval !== undefined) {
    if (!Number.isInteger(args.reflectionInterval) || args.reflectionInterval < 0) {
      throw new Error(`Invalid --reflection-interval ${args.reflectionInterval}: expected non-negative integer (0 disables)`);
    }
    defaultReflectionInterval = args.reflectionInterval;
    reflectionSource = "flag";
  }

  // shutdownGraceMs — drain window for graceful shutdown (PRI-1477).
  // No flag override; this is an operator-level knob (env only).
  const shutdownGraceMs = parseNonNegIntEnv(
    env.GAUNTLET_SHUTDOWN_GRACE_MS,
    "GAUNTLET_SHUTDOWN_GRACE_MS",
    DEFAULT_SHUTDOWN_GRACE_MS,
  );
  const shutdownGraceMsSource: "default" | "env" = env.GAUNTLET_SHUTDOWN_GRACE_MS ? "env" : "default";

  // PRI-1478 caps — operator-level knobs (env only). Each parses a
  // non-negative integer or throws with a uniform shape.
  const maxRequestBodySize = parseNonNegIntEnv(
    env.GAUNTLET_MAX_REQUEST_BODY_SIZE,
    "GAUNTLET_MAX_REQUEST_BODY_SIZE",
    DEFAULT_MAX_REQUEST_BODY_SIZE,
  );
  const maxRequestBodySizeSource: "default" | "env" =
    env.GAUNTLET_MAX_REQUEST_BODY_SIZE ? "env" : "default";

  const maxConcurrentRuns = parseNonNegIntEnv(
    env.GAUNTLET_MAX_CONCURRENT_RUNS,
    "GAUNTLET_MAX_CONCURRENT_RUNS",
    DEFAULT_MAX_CONCURRENT_RUNS,
  );
  const maxConcurrentRunsSource: "default" | "env" =
    env.GAUNTLET_MAX_CONCURRENT_RUNS ? "env" : "default";

  const activeRunTargetMaxBytes = parseNonNegIntEnv(
    env.GAUNTLET_ACTIVE_RUN_TARGET_MAX_BYTES,
    "GAUNTLET_ACTIVE_RUN_TARGET_MAX_BYTES",
    DEFAULT_ACTIVE_RUN_TARGET_MAX_BYTES,
  );
  const activeRunTargetMaxBytesSource: "default" | "env" =
    env.GAUNTLET_ACTIVE_RUN_TARGET_MAX_BYTES ? "env" : "default";

  // PRI-1483 WebSocket hygiene knobs.
  const wsIdleTimeoutSec = parseNonNegIntEnv(
    env.GAUNTLET_WS_IDLE_TIMEOUT_SEC,
    "GAUNTLET_WS_IDLE_TIMEOUT_SEC",
    DEFAULT_WS_IDLE_TIMEOUT_SEC,
  );
  const wsIdleTimeoutSecSource: "default" | "env" =
    env.GAUNTLET_WS_IDLE_TIMEOUT_SEC ? "env" : "default";

  const wsOriginAllowlist = env.GAUNTLET_WS_ORIGIN_ALLOWLIST
    ? env.GAUNTLET_WS_ORIGIN_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const wsOriginAllowlistSource: "default" | "env" =
    env.GAUNTLET_WS_ORIGIN_ALLOWLIST ? "env" : "default";

  // models.agent
  let agentModel = DEFAULT_AGENT_MODEL;
  let agentSource: "default" | "env" | "flag" = "default";
  if (env.GAUNTLET_AGENT_MODEL) {
    agentModel = env.GAUNTLET_AGENT_MODEL;
    agentSource = "env";
  }
  if (args.models?.agent) {
    agentModel = args.models.agent;
    agentSource = "flag";
  }

  // models.fanout
  let fanoutModel: string | undefined;
  let fanoutSource: "default" | "env" | "flag" | "unset" = "unset";
  if (env.GAUNTLET_FANOUT_MODEL) {
    fanoutModel = env.GAUNTLET_FANOUT_MODEL;
    fanoutSource = "env";
  }
  if (args.models?.fanout) {
    fanoutModel = args.models.fanout;
    fanoutSource = "flag";
  }

  // models.available — operator-controlled allow-list. Empty means "no
  // restriction": per-request body model overrides flow through unchecked.
  // When the operator sets GAUNTLET_MODELS, the route layer enforces it.
  let availableModels: string[] = [];
  let availableSource: "default" | "env" | "flag" = "default";
  if (env.GAUNTLET_MODELS) {
    availableModels = env.GAUNTLET_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
    availableSource = "env";
  }

  // apiKeys (presence only)
  const apiKeys = {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    openai: Boolean(env.OPENAI_API_KEY),
  };

  // credentialResolver — caller-provided fetch_credential backend (PRI-1605).
  let credentialResolver: CredentialResolverConfig | undefined;
  let credentialResolverSource: "default" | "env" = "default";
  if (env.GAUNTLET_CREDENTIAL_RESOLVER) {
    const resolvedPath = resolveCredentialResolver(
      env.GAUNTLET_CREDENTIAL_RESOLVER,
      projectRoot,
    );
    const timeoutMs = parseNonNegIntEnv(
      env.GAUNTLET_CREDENTIAL_RESOLVER_TIMEOUT_MS,
      "GAUNTLET_CREDENTIAL_RESOLVER_TIMEOUT_MS",
      DEFAULT_CREDENTIAL_RESOLVER_TIMEOUT_MS,
    );
    const includeInTranscripts = env.GAUNTLET_CREDENTIAL_INCLUDE_IN_TRANSCRIPTS
      ? parseBoolEnv(env.GAUNTLET_CREDENTIAL_INCLUDE_IN_TRANSCRIPTS, "GAUNTLET_CREDENTIAL_INCLUDE_IN_TRANSCRIPTS")
      : false;
    credentialResolver = { path: resolvedPath, timeoutMs, includeInTranscripts };
    credentialResolverSource = "env";
  }

  return {
    projectRoot,
    port,
    defaultChrome,
    defaultTarget,
    defaultBudgetMs,
    defaultReflectionInterval,
    defaultViewport,
    defaultSaveScreencast,
    shutdownGraceMs,
    maxRequestBodySize,
    maxConcurrentRuns,
    activeRunTargetMaxBytes,
    wsIdleTimeoutSec,
    wsOriginAllowlist,
    models: {
      agent: agentModel,
      fanout: fanoutModel,
      available: availableModels,
    },
    apiKeys,
    credentialResolver,
    sources: {
      projectRoot: projectRootSource,
      port: portSource,
      defaultChrome: chromeSource,
      defaultTarget: targetSource,
      defaultBudgetMs: budgetSource,
      defaultReflectionInterval: reflectionSource,
      defaultViewport: viewportSource,
      defaultSaveScreencast: saveScreencastSource,
      shutdownGraceMs: shutdownGraceMsSource,
      maxRequestBodySize: maxRequestBodySizeSource,
      maxConcurrentRuns: maxConcurrentRunsSource,
      activeRunTargetMaxBytes: activeRunTargetMaxBytesSource,
      wsIdleTimeoutSec: wsIdleTimeoutSecSource,
      wsOriginAllowlist: wsOriginAllowlistSource,
      "models.agent": agentSource,
      "models.fanout": fanoutSource,
      "models.available": availableSource,
      credentialResolver: credentialResolverSource,
    },
  };
}
