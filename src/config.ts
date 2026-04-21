import { ADAPTER_TYPES, isAdapterType, type AdapterType } from "./adapters/adapter";

export interface ChromeEndpoint {
  host: string;
  port: number;
}

export interface Viewport {
  width: number;
  height: number;
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
   * Hard cap on agent turns per run. Applies to every adapter. Per-run
   * overrides (request body `turns` or CLI `--turns`) take precedence.
   */
  defaultTurns: number;
  /**
   * Viewport applied to the browsing tab on web-adapter runs (via
   * `Emulation.setDeviceMetricsOverride`). Per-run overrides (request
   * body `viewport` or CLI `--viewport`) take precedence.
   */
  defaultViewport: Viewport;
  models: {
    agent: string;
    fanout?: string;
    available: string[];
  };
  apiKeys: {
    anthropic: boolean;
    openai: boolean;
  };
  sources: {
    projectRoot: "default" | "env" | "flag";
    port: "default" | "env" | "flag";
    defaultChrome: "default" | "env" | "flag";
    defaultTarget: "default" | "env" | "flag" | "unset";
    defaultTurns: "default" | "env" | "flag";
    defaultViewport: "default" | "env" | "flag";
    "models.agent": "default" | "env" | "flag";
    "models.fanout": "default" | "env" | "flag" | "unset";
    "models.available": "default" | "env" | "flag";
  };
}

export interface CliArgsInput {
  projectRoot?: string;
  port?: number;
  chrome?: string;
  target?: string;
  turns?: number;
  viewport?: string;
  models?: { agent?: string; fanout?: string };
}

export interface RunRequestBody {
  target: string;
  model?: string;
  chrome?: string;
  adapter?: AdapterType;
  turns?: number;
  viewport?: Viewport;
}

export interface EffectiveRunConfig {
  target: string;
  model: string;
  /**
   * Undefined means: caller did not specify an endpoint and the server
   * config is at its default — let WebAdapter auto-launch a local Chrome.
   * A defined value means an explicit endpoint (from body, env, or flag).
   */
  chrome: ChromeEndpoint | undefined;
  adapter: AdapterType;
  turns: number;
  viewport: Viewport;
  projectRoot: string;
}

const RUN_BODY_ALLOWED = new Set(["target", "model", "chrome", "adapter", "turns", "viewport"]);
export const DEFAULT_MAX_TURNS = 50;
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

export function validateRunBody(body: unknown): RunRequestBody {
  if (!body || typeof body !== "object") {
    throw new Error("run request body must be an object");
  }
  const bodyObj = body as Record<string, unknown>;
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
  let turns: number | undefined;
  if (bodyObj.turns !== undefined) {
    if (typeof bodyObj.turns !== "number" || !Number.isFinite(bodyObj.turns) || !Number.isInteger(bodyObj.turns) || bodyObj.turns < 1) {
      throw new Error("run request body: turns must be a positive integer");
    }
    turns = bodyObj.turns;
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
  return {
    target: bodyObj.target,
    model: typeof bodyObj.model === "string" ? bodyObj.model : undefined,
    chrome: typeof bodyObj.chrome === "string" ? bodyObj.chrome : undefined,
    adapter: bodyObj.adapter,
    turns,
    viewport,
  };
}

export function mergeRunConfig(app: AppConfig, body: RunRequestBody): EffectiveRunConfig {
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
    turns: body.turns ?? app.defaultTurns,
    viewport: body.viewport ?? app.defaultViewport,
    projectRoot: app.projectRoot,
  };
}

const DEFAULT_PROJECT_ROOT = ".";
const DEFAULT_PORT = 4400;
const DEFAULT_CHROME: ChromeEndpoint = { host: "127.0.0.1", port: 9222 };
const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";

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
  let projectRoot = DEFAULT_PROJECT_ROOT;
  let projectRootSource: "default" | "env" | "flag" = "default";
  if (env.GAUNTLET_PROJECT_ROOT) {
    projectRoot = env.GAUNTLET_PROJECT_ROOT;
    projectRootSource = "env";
  }
  if (args.projectRoot !== undefined) {
    projectRoot = args.projectRoot;
    projectRootSource = "flag";
  }

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

  // defaultTurns — hard cap on agent turns per run.
  let defaultTurns = DEFAULT_MAX_TURNS;
  let turnsSource: "default" | "env" | "flag" = "default";
  if (env.GAUNTLET_TURNS) {
    const parsed = parseInt(env.GAUNTLET_TURNS, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      throw new Error(`Invalid GAUNTLET_TURNS "${env.GAUNTLET_TURNS}": expected a positive integer`);
    }
    defaultTurns = parsed;
    turnsSource = "env";
  }
  if (args.turns !== undefined) {
    if (!Number.isInteger(args.turns) || args.turns < 1) {
      throw new Error(`Invalid --turns ${args.turns}: expected a positive integer`);
    }
    defaultTurns = args.turns;
    turnsSource = "flag";
  }

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

  return {
    projectRoot,
    port,
    defaultChrome,
    defaultTarget,
    defaultTurns,
    defaultViewport,
    models: {
      agent: agentModel,
      fanout: fanoutModel,
      available: availableModels,
    },
    apiKeys,
    sources: {
      projectRoot: projectRootSource,
      port: portSource,
      defaultChrome: chromeSource,
      defaultTarget: targetSource,
      defaultTurns: turnsSource,
      defaultViewport: viewportSource,
      "models.agent": agentSource,
      "models.fanout": fanoutSource,
      "models.available": availableSource,
    },
  };
}
