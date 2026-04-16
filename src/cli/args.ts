import type { CliArgsInput } from "../config";
import { ADAPTER_TYPES, isAdapterType, type AdapterType } from "../adapters/adapter";

/**
 * parseInt("abc", 10) returns NaN, which propagates through loadConfig
 * (typeof NaN === "number") and ultimately crashes Bun.serve. Reject
 * non-integer values up front with a clean error, matching how
 * GAUNTLET_PORT is validated inside loadConfig.
 */
function parseIntFlag(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${label} value "${raw}": expected an integer`);
  }
  return parsed;
}

const RUN_ALLOWED = new Set(["target", "out", "adapter", "model", "chrome", "project-dir"]);
const VALIDATE_ALLOWED = new Set<string>([]);
const FANOUT_ALLOWED = new Set(["out", "model", "from-result"]);
const SERVE_ALLOWED = new Set(["port", "project-dir", "chrome", "target", "model"]);
const CONFIG_ALLOWED = new Set(["json", "project-dir", "port", "chrome", "target", "model"]);

function rejectUnknownFlags(
  flags: Record<string, unknown>,
  allowed: Set<string>,
  command: string,
): void {
  const unknown = Object.keys(flags).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    const validList = [...allowed].sort().map((f) => `--${f}`).join(", ");
    throw new Error(
      `Unknown flag${unknown.length > 1 ? "s" : ""} for "gauntlet ${command}": ${unknown.map((f) => `--${f}`).join(", ")}\n\nValid flags: ${validList || "(none)"}`,
    );
  }
}

export interface RunArgs {
  command: "run";
  scenarioPath: string;
  outDir: string;
  adapter: AdapterType;
  cli: CliArgsInput;
}

export interface ValidateArgs {
  command: "validate";
  scenarioPath: string;
}

export interface FanoutArgs {
  command: "fanout";
  scenarioPath?: string;
  resultDir?: string;
  outDir: string;
  cli: CliArgsInput;
}

export interface ServeArgs {
  command: "serve";
  cli: CliArgsInput;
}

export interface ConfigArgs {
  command: "config";
  json: boolean;
  cli: CliArgsInput;
}

export type ParsedArgs = RunArgs | ValidateArgs | FanoutArgs | ServeArgs | ConfigArgs;

export function parseArgs(argv: string[]): ParsedArgs {
  // Skip "bun" and script name
  const args = argv.slice(2);
  const command = args[0];

  if (!command) {
    throw new Error(usage());
  }

  switch (command) {
    case "run":
      return parseRunArgs(args.slice(1));
    case "validate":
      return parseValidateArgs(args.slice(1));
    case "fanout":
      return parseFanoutArgs(args.slice(1));
    case "serve":
      return parseServeArgs(args.slice(1));
    case "config":
      return parseConfigArgs(args.slice(1));
    default:
      throw new Error(`Unknown command: ${command}\n${usage()}`);
  }
}

function parseConfigArgs(args: string[]): ConfigArgs {
  // `--json` works as a bareword (parseFlags maps it to "true") or as
  // an explicit `--json true`. parseFlags now refuses to swallow a
  // following `--flag` as the value, so no special-casing is needed.
  const flags = parseFlags(args);
  rejectUnknownFlags(flags, CONFIG_ALLOWED, "config");
  return {
    command: "config",
    json: flags.json === "true",
    cli: {
      projectRoot: flags["project-dir"],
      port: parseIntFlag(flags.port, "--port"),
      chrome: flags.chrome,
      target: flags.target,
      models: parseModelFlagArray(flags.model),
    },
  };
}

function parseRunArgs(args: string[]): RunArgs {
  const positional = extractPositional(args);
  if (!positional) {
    throw new Error("Missing scenario path\n\nUsage: gauntlet run <scenario.md> --target <url>");
  }

  const flags = parseFlags(args);
  rejectUnknownFlags(flags, RUN_ALLOWED, "run");
  if (!flags.target) {
    throw new Error("Missing required flag: --target <url>");
  }

  let adapter: AdapterType = "web";
  if (flags.adapter !== undefined) {
    if (!isAdapterType(flags.adapter)) {
      throw new Error(
        `Invalid --adapter value "${flags.adapter}": must be one of ${ADAPTER_TYPES.join(", ")}`,
      );
    }
    adapter = flags.adapter;
  }

  return {
    command: "run",
    scenarioPath: positional,
    outDir: flags.out ?? "./evidence",
    adapter,
    cli: {
      projectRoot: flags["project-dir"],
      chrome: flags.chrome,
      target: flags.target,
      models: parseModelFlagArray(flags.model),
    },
  };
}

function parseValidateArgs(args: string[]): ValidateArgs {
  const positional = extractPositional(args);
  if (!positional) {
    throw new Error("Missing scenario path\n\nUsage: gauntlet validate <scenario.md>");
  }

  const flags = parseFlags(args);
  rejectUnknownFlags(flags, VALIDATE_ALLOWED, "validate");

  return {
    command: "validate",
    scenarioPath: positional,
  };
}

function parseFanoutArgs(args: string[]): FanoutArgs {
  const positional = extractPositional(args);
  const flags = parseFlags(args);
  rejectUnknownFlags(flags, FANOUT_ALLOWED, "fanout");
  const resultDir = flags["from-result"];

  if (!positional && !resultDir) {
    throw new Error("Missing scenario path or --from-result\n\nUsage: gauntlet fanout <scenario.md> | --from-result <result-dir>");
  }

  return {
    command: "fanout",
    scenarioPath: positional,
    resultDir,
    outDir: flags.out ?? "./",
    cli: {
      models: parseModelFlagArray(flags.model),
    },
  };
}

function parseServeArgs(args: string[]): ServeArgs {
  const flags = parseFlags(args);
  rejectUnknownFlags(flags, SERVE_ALLOWED, "serve");

  return {
    command: "serve",
    cli: {
      projectRoot: flags["project-dir"],
      port: parseIntFlag(flags.port, "--port"),
      chrome: flags.chrome,
      target: flags.target,
      models: parseModelFlagArray(flags.model),
    },
  };
}

function parseModelFlagArray(modelFlags: string[] | undefined): { agent?: string; fanout?: string } | undefined {
  if (!modelFlags || modelFlags.length === 0) return undefined;
  const out: { agent?: string; fanout?: string } = {};
  for (const flag of modelFlags) {
    const idx = flag.indexOf("=");
    if (idx === -1) continue;
    const role = flag.slice(0, idx);
    const model = flag.slice(idx + 1);
    if (role === "agent") out.agent = model;
    else if (role === "fanout") out.fanout = model;
  }
  return out;
}

/** Extract the first positional argument (non-flag, not a flag value) */
function extractPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      i++; // skip flag value
      continue;
    }
    return args[i];
  }
  return undefined;
}

/** Parse --flag value pairs. Repeatable flags (like --model) collect into arrays.
 *
 * A flag whose "value" begins with `--` (or is missing entirely) is treated as
 * a bareword flag — `flags[key] = "true"` — and the next token is left in
 * place for the next iteration. This prevents `--json --project-dir /tmp` from
 * silently eating the `--project-dir` token as the value of `--json`.
 */
function parseFlags(args: string[]): Record<string, string> & { model?: string[] } {
  const flags: Record<string, string> = {};
  const models: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;

    const key = args[i].slice(2);
    const value = args[i + 1];

    if (key === "model") {
      if (value !== undefined && !value.startsWith("--")) {
        models.push(value);
        i++;
      }
      // bareword --model is meaningless, but don't swallow the next flag
    } else {
      if (value !== undefined && !value.startsWith("--")) {
        flags[key] = value;
        i++;
      } else {
        flags[key] = "true"; // bareword flag
      }
    }
  }

  const result = flags as Record<string, string> & { model?: string[] };
  if (models.length > 0) result.model = models;
  return result;
}

function usage(): string {
  return `Usage: gauntlet <command> [options]

Commands:
  run <scenario.md>    Run a scenario
    --target <url>       (required) Application under test
    --model agent=<name> Model for the agent (default: claude-sonnet-4-6)
    --chrome host:port   Chrome debugging endpoint (default: 127.0.0.1:9222)
    --adapter <type>     web | cli | tui (default: web)
    --out <dir>          Evidence output directory (default: ./evidence)
    --project-dir <dir>  Project root (contains .gauntlet/ state dir)

  validate <scenario.md>  Validate a scenario file

  fanout <scenario.md>    Fan out scenario into sub-scenarios
    --out <dir>             Output directory
    --model fanout=<name>   Model for generation
    --from-result <dir>     Generate from an existing result directory

  serve                    Start the API server
    --port <n>               Server port (default: 4400)
    --project-dir <dir>      Project root (contains .gauntlet/ state dir)
    --chrome host:port       Default Chrome endpoint for runs
    --target <url>           Default target (hint only; UI still overrides)
    --model agent=<name>     Default agent model

  config                   Print effective configuration
    --json                   Emit JSON instead of text (also accepts --json true)
    (also accepts the same knobs as serve/run, for "what would happen if...")

Environment:
  GAUNTLET_PORT            Server port
  GAUNTLET_PROJECT_ROOT    Project root (contains .gauntlet/ state dir)
  GAUNTLET_CHROME          Default Chrome endpoint (host:port)
  GAUNTLET_AGENT_MODEL     Default agent model
  GAUNTLET_FANOUT_MODEL    Default fanout model
  GAUNTLET_MODELS          Comma-separated model allow-list

  ANTHROPIC_API_KEY        Read by the Anthropic SDK (if using Claude models)
  OPENAI_API_KEY           Read by the OpenAI SDK (if using GPT models)

Run 'gauntlet config' to see effective configuration at any time.`;
}
