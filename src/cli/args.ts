import { parseModelFlags } from "../models/resolve";
import type { ModelConfig } from "../types";
import type { CliArgsInput } from "../config";

const RUN_ALLOWED = new Set(["target", "out", "adapter", "model", "chrome", "data-dir"]);
const VALIDATE_ALLOWED = new Set<string>([]);
const FANOUT_ALLOWED = new Set(["out", "model", "from-result"]);
const SERVE_ALLOWED = new Set(["port", "data-dir", "chrome", "target", "model"]);

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
  adapter: "web" | "cli" | "tui";
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
  models: ModelConfig;
}

export interface ServeArgs {
  command: "serve";
  cli: CliArgsInput;
}

export type ParsedArgs = RunArgs | ValidateArgs | FanoutArgs | ServeArgs;

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
    default:
      throw new Error(`Unknown command: ${command}\n${usage()}`);
  }
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

  return {
    command: "run",
    scenarioPath: positional,
    outDir: flags.out ?? "./evidence",
    adapter: (flags.adapter as "web" | "cli" | "tui") ?? "web",
    cli: {
      dataDir: flags["data-dir"],
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

  const parsed = parseModelFlags(flags.model ?? []);
  const models: ModelConfig = {
    agent: parsed.agent || process.env.GAUNTLET_AGENT_MODEL || "claude-sonnet-4-6",
    fanout: parsed.fanout || process.env.GAUNTLET_FANOUT_MODEL,
  };

  return {
    command: "fanout",
    scenarioPath: positional,
    resultDir,
    outDir: flags.out ?? "./",
    models,
  };
}

function parseServeArgs(args: string[]): ServeArgs {
  const flags = parseFlags(args);
  rejectUnknownFlags(flags, SERVE_ALLOWED, "serve");

  return {
    command: "serve",
    cli: {
      dataDir: flags["data-dir"],
      port: flags.port ? parseInt(flags.port, 10) : undefined,
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

/** Parse --flag value pairs. Repeatable flags (like --model) collect into arrays. */
function parseFlags(args: string[]): Record<string, string> & { model?: string[] } {
  const flags: Record<string, string> = {};
  const models: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;

    const key = args[i].slice(2);
    const value = args[i + 1];

    if (key === "model") {
      if (value) models.push(value);
      i++;
    } else {
      if (value) flags[key] = value;
      i++;
    }
  }

  const result = flags as Record<string, string> & { model?: string[] };
  if (models.length > 0) result.model = models;
  return result;
}

function usage(): string {
  return `Usage: gauntlet <command> [options]

Commands:
  run <scenario.md> --target <url>   Run a scenario
  validate <scenario.md>             Validate a scenario file
  fanout <scenario.md>               Fan out scenario into sub-scenarios
  serve                              Start the API server`;
}
