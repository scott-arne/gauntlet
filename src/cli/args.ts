import { parseModelFlags } from "../models/resolve";
import type { ModelConfig } from "../types";

export interface RunArgs {
  command: "run";
  scenarioPath: string;
  target: string;
  outDir: string;
  adapter: "web" | "cli" | "tui";
  models: ModelConfig;
  chrome?: string;
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
  port: number;
  dataDir?: string;
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
  const target = flags.target;
  if (!target) {
    throw new Error("Missing required flag: --target <url>");
  }

  return {
    command: "run",
    scenarioPath: positional,
    target,
    outDir: flags.out ?? "./evidence",
    adapter: (flags.adapter as "web" | "cli" | "tui") ?? "web",
    models: parseModelFlags(flags.model ?? []),
    chrome: flags.chrome,
  };
}

function parseValidateArgs(args: string[]): ValidateArgs {
  const positional = extractPositional(args);
  if (!positional) {
    throw new Error("Missing scenario path\n\nUsage: gauntlet validate <scenario.md>");
  }

  return {
    command: "validate",
    scenarioPath: positional,
  };
}

function parseFanoutArgs(args: string[]): FanoutArgs {
  const positional = extractPositional(args);
  const flags = parseFlags(args);
  const resultDir = flags["from-result"];

  if (!positional && !resultDir) {
    throw new Error("Missing scenario path or --from-result\n\nUsage: gauntlet fanout <scenario.md> | --from-result <result-dir>");
  }

  return {
    command: "fanout",
    scenarioPath: positional,
    resultDir,
    outDir: flags.out ?? "./",
    models: parseModelFlags(flags.model ?? []),
  };
}

function parseServeArgs(args: string[]): ServeArgs {
  const flags = parseFlags(args);

  return {
    command: "serve",
    port: flags.port ? parseInt(flags.port, 10) : parseInt(process.env.GAUNTLET_PORT || "4400", 10),
    dataDir: flags["data-dir"],
  };
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
