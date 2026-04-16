export interface ChromeEndpoint {
  host: string;
  port: number;
}

export interface AppConfig {
  projectRoot: string;
  port: number;
  defaultChrome: ChromeEndpoint;
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
  models?: { agent?: string; fanout?: string };
}

export interface RunRequestBody {
  target: string;
  model?: string;
  chrome?: string;
  adapter?: "web" | "cli" | "tui";
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
  adapter: "web" | "cli" | "tui";
  projectRoot: string;
}

const RUN_BODY_ALLOWED = new Set(["target", "model", "chrome", "adapter"]);

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
  return {
    target: bodyObj.target,
    model: typeof bodyObj.model === "string" ? bodyObj.model : undefined,
    chrome: typeof bodyObj.chrome === "string" ? bodyObj.chrome : undefined,
    adapter: bodyObj.adapter as EffectiveRunConfig["adapter"] | undefined,
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
  const model = body.model ?? app.models.agent;
  checkAgentModelFloor(model, body.model ? "run.model" : "GAUNTLET_AGENT_MODEL");
  return {
    target: body.target,
    model,
    chrome,
    adapter: body.adapter ?? "web",
    projectRoot: app.projectRoot,
  };
}

const DEFAULT_PROJECT_ROOT = ".";
const DEFAULT_PORT = 4400;
const DEFAULT_CHROME: ChromeEndpoint = { host: "127.0.0.1", port: 9222 };
const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";

/**
 * The Gauntlet v1.5 Sonnet 4.6 floor (spec §9). Models at or above the
 * floor are considered "v1.5-capable". This list is additive as newer
 * variants ship; anything not here is rejected at the "about to actually
 * run" seams (`requireLlmCapable` and `mergeRunConfig`).
 *
 * Intentionally NOT checked in `loadConfig` — `gauntlet config` must be
 * able to introspect broken environments without throwing.
 */
export const AGENT_MODEL_FLOOR_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  "claude-sonnet-4-6",
  "claude-opus-4-6",
]);

/**
 * Throws a descriptive error if `model` is not in the v1.5 floor allowlist.
 * `label` is prepended to the error message to tell the caller which seam
 * tripped the check (e.g. "GAUNTLET_AGENT_MODEL" or "run.model").
 */
export function checkAgentModelFloor(model: string, label: string): void {
  if (!AGENT_MODEL_FLOOR_ALLOWLIST.has(model)) {
    const allowed = [...AGENT_MODEL_FLOOR_ALLOWLIST].join(", ");
    throw new Error(
      `${label}: model "${model}" is below the Gauntlet v1.5 floor. ` +
        `The floor is Sonnet 4.6; use one of: ${allowed}.`,
    );
  }
}

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
  checkAgentModelFloor(config.models.agent, "GAUNTLET_AGENT_MODEL");
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

  // models.available
  let availableModels: string[];
  let availableSource: "default" | "env" | "flag" = "default";
  if (env.GAUNTLET_MODELS) {
    availableModels = env.GAUNTLET_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
    availableSource = "env";
  } else {
    availableModels = [agentModel];
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
      "models.agent": agentSource,
      "models.fanout": fanoutSource,
      "models.available": availableSource,
    },
  };
}
