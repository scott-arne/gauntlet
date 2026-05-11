import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseStoryCard } from "../format/story-card";
import { buildInitialUserMessage } from "../agent/initial-message";
import { buildScenarioBlocks } from "../agent/prompts";
import { renderContextTree } from "../context/tree";
import { resolveProjectPrompt } from "../runs/orchestrator";
import { loadPromptFile } from "../agent/prompts/loader";
import type { Adapter, AdapterType } from "../adapters/adapter";
import { WebAdapter } from "../adapters/web/adapter";
import { CLIAdapter } from "../adapters/cli/adapter";
import { TUIAdapter } from "../adapters/tui/adapter";

export interface ShowPromptOptions {
  scenarioPath: string;
  target: string;
  adapter: AdapterType;
  projectRoot: string;
  projectPromptPath?: string;
  viewport: string;
  maxStuckRetries: number;
}

const SEP = "─".repeat(3);

function header(label: string, provenance: string): string {
  return `${SEP} ${label} ${"─".repeat(Math.max(2, 24 - label.length))}  ${provenance}`;
}

function asciiHeader(label: string, provenance: string): string {
  return `--- ${label} ${"-".repeat(Math.max(2, 24 - label.length))}  ${provenance}`;
}

/**
 * Construct an adapter instance solely for introspection. We pass
 * `contextRoot` so the read-tool definition appears in `toolDefinitions()`,
 * matching what the agent sees at runtime. We do NOT call `start()` —
 * `toolDefinitions()` and `describeTarget()` are pure on the constructed
 * instance, no Chrome / tmux / subprocess is spawned.
 */
function adapterForIntrospect(name: AdapterType, contextRoot: string): Adapter {
  switch (name) {
    case "web":
      return new WebAdapter({ contextRoot });
    case "cli":
      return new CLIAdapter({ contextRoot });
    case "tui":
      return new TUIAdapter({ contextRoot });
  }
}

export function showPromptAndExit(opts: ShowPromptOptions): void {
  const useAscii = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
  const h = useAscii ? asciiHeader : header;

  const card = parseStoryCard(readFileSync(opts.scenarioPath, "utf-8"));
  const contextRoot = join(opts.projectRoot, ".gauntlet", "context");
  const contextTree = existsSync(contextRoot) ? renderContextTree(contextRoot) : "";
  const projectPrompt = resolveProjectPrompt(opts.projectRoot, opts.projectPromptPath);

  // Honest introspection: instantiate the actual adapter (no start()) so
  // tool list and describeTarget() match what the agent receives. The
  // constructor is pure for all three adapter types — see
  // `adapterForIntrospect` above.
  const adapter = adapterForIntrospect(opts.adapter, contextRoot);

  const out: string[] = [];

  out.push(h("Persona", `src/agent/prompts/persona.md`));
  out.push(loadPromptFile("persona"));
  out.push("");

  out.push(h("Scenario", `(from card: ${opts.scenarioPath})`));
  // Use the same builder buildSystemPrompt uses, joined with the same
  // \n\n joiner — guaranteed to match the runtime Scenario text.
  out.push(buildScenarioBlocks(card).join("\n\n"));
  out.push("");

  out.push(h("Evaluation", `src/agent/prompts/evaluation.md`));
  out.push(loadPromptFile("evaluation"));
  out.push("");

  out.push(h("Stuck-handling", `src/agent/prompts/stuck-handling.md`));
  out.push(
    loadPromptFile("stuck-handling").replace(
      "{{MAX_STUCK_RETRIES}}",
      String(opts.maxStuckRetries),
    ),
  );
  out.push("");

  const adapterFile = `src/agent/prompts/adapter-${opts.adapter}.md`;
  const adapterBody = loadPromptFile(`adapter-${opts.adapter}`);
  out.push(h(`Adapter (${opts.adapter})`, adapterFile));
  out.push(adapterBody.length > 0 ? adapterBody : "(empty file)");
  out.push("");

  if (projectPrompt) {
    const provenance = opts.projectPromptPath
      ? `${opts.projectPromptPath}   (caller-supplied)`
      : `${join(opts.projectRoot, ".gauntlet", "project.md")}   (default)`;
    out.push(h("Project", provenance));
    out.push(projectPrompt);
  } else {
    out.push(h("Project", "(none)"));
  }
  out.push("");

  if (contextTree.length > 0) {
    // At runtime, executeRunCore reads from a snapshotted copy under
    // <outDir>/inputs/context — contents identical by construction. The
    // path shown here is the project-root source of truth.
    out.push(h("Context", `src/agent/prompts/context.md + ${contextRoot} (snapshotted at run time)`));
    out.push(loadPromptFile("context").replace("{{TREE_LISTING}}", contextTree));
  } else {
    out.push(h("Context", "(none)"));
  }
  out.push("");

  out.push(h("Tools", `(from adapter: ${opts.adapter})`));
  for (const tool of adapter.toolDefinitions()) {
    // Collapse multi-line descriptions to single-line summaries so the
    // listing stays scannable. Each tool's full description is in the
    // adapter source — this view is for orientation, not reference.
    const summary = (tool.description ?? "").replace(/\s+/g, " ").trim();
    out.push(`- ${tool.name}: ${summary}`);
  }
  // The agent always gets `report_result` appended; mirror that here.
  out.push(`- report_result: Report your test result. Call this when you are done testing.`);
  out.push("");

  out.push(h("Initial user message", "(from adapter.describeTarget)"));
  out.push(buildInitialUserMessage(adapter, opts.target.length > 0 ? opts.target : undefined));
  out.push("");

  process.stdout.write(out.join("\n"));
}
