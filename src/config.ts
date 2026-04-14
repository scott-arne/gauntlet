export interface ChromeEndpoint {
  host: string;
  port: number;
}

export interface AppConfig {
  dataDir: string;
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
    dataDir: "default" | "env" | "flag";
    port: "default" | "env" | "flag";
    defaultChrome: "default" | "env" | "flag";
    "models.agent": "default" | "env" | "flag";
    "models.fanout": "default" | "env" | "flag" | "unset";
    "models.available": "default" | "env" | "flag";
  };
}

export interface CliArgsInput {
  dataDir?: string;
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
  chrome: ChromeEndpoint;
  adapter: "web" | "cli" | "tui";
  dataDir: string;
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
  const chrome = body.chrome
    ? parseChromeEndpoint(body.chrome, "body.chrome")
    : app.defaultChrome;
  return {
    target: body.target,
    model: body.model ?? app.models.agent,
    chrome,
    adapter: body.adapter ?? "web",
    dataDir: app.dataDir,
  };
}

const DEFAULT_DATA_DIR = ".";
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

export function loadConfig(args: CliArgsInput, env: NodeJS.ProcessEnv): AppConfig {
  // dataDir
  let dataDir = DEFAULT_DATA_DIR;
  let dataDirSource: "default" | "env" | "flag" = "default";
  if (env.GAUNTLET_DATA_DIR) {
    dataDir = env.GAUNTLET_DATA_DIR;
    dataDirSource = "env";
  }
  if (args.dataDir !== undefined) {
    dataDir = args.dataDir;
    dataDirSource = "flag";
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
    dataDir,
    port,
    defaultChrome,
    models: {
      agent: agentModel,
      fanout: fanoutModel,
      available: availableModels,
    },
    apiKeys,
    sources: {
      dataDir: dataDirSource,
      port: portSource,
      defaultChrome: chromeSource,
      "models.agent": agentSource,
      "models.fanout": fanoutSource,
      "models.available": availableSource,
    },
  };
}
