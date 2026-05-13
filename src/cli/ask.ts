import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { createInterface } from "readline";
import type { AskArgs } from "./args";
import type { AppConfig } from "../config";
import type { LLMClient } from "../models/provider";
import { rebuildMessages, ANSWER_TOOL, extractAnswer } from "../revival";
import { createClient, UnknownModelProviderError } from "../models/resolve";

export async function ask(args: AskArgs, config: AppConfig): Promise<number> {
  const runDir = resolve(config.projectRoot, ".gauntlet", "results", args.runId);
  if (!existsSync(runDir)) {
    console.error(`Run not found: ${args.runId} (looked in ${runDir})`);
    return 1;
  }
  const jsonlPath = resolve(runDir, "run.jsonl");
  if (!existsSync(jsonlPath)) {
    console.error(`Run ${args.runId} has no run.jsonl; cannot revive`);
    return 1;
  }

  // Look up the recorded model first so we can show a helpful error
  // before doing the full rebuild.
  const recordedModelId = peekRecordedModel(runDir);
  const modelToUse = args.modelOverride ?? recordedModelId;
  let client: LLMClient;
  try {
    client = createClient(modelToUse);
  } catch (err) {
    if (err instanceof UnknownModelProviderError) {
      console.error(
        `Run ${args.runId} was recorded against model ${recordedModelId}, which is no longer available. ` +
        `To revive against a different model, pass --model <model-id>. ` +
        `Note that the answers will be from a different model than the one that produced the original run.`,
      );
      return 1;
    }
    throw err;
  }

  let rebuilt;
  try {
    rebuilt = rebuildMessages(runDir, client, args.upToTurn);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Cannot revive run: ${msg}`);
    return 1;
  }

  const recordedDate = peekRecordedDate(runDir);
  const overrideNote =
    args.modelOverride && args.modelOverride !== rebuilt.modelId
      ? ` (override: ${args.modelOverride}; recorded was ${rebuilt.modelId})`
      : "";
  console.log(
    `Revival of run ${args.runId} against model ${modelToUse}${overrideNote} (recorded ${recordedDate})`,
  );
  console.log(`Adapter: ${rebuilt.adapterName}`);
  for (const w of rebuilt.warnings) console.log(`  ! ${w}`);
  console.log(`Type your question. Ctrl-D, Ctrl-C, or :quit to exit.`);
  console.log("");

  const messages = [...rebuilt.messages];

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "? " });
  rl.prompt();

  return new Promise<number>((resolveExit) => {
    // Guard against re-entrant line events: chat() takes seconds against
    // a long transcript, and any input typed while it's in flight
    // (including stray newlines) would otherwise spawn a parallel
    // listener — racy and confusing. pause/resume around the call.
    let inFlight = false;

    rl.on("line", async (line) => {
      if (inFlight) return;
      const q = line.trim();
      if (q === ":quit") {
        rl.close();
        return;
      }
      if (q === "") {
        // Empty enter just re-prompts. Only :quit / Ctrl-D / Ctrl-C exit.
        rl.prompt();
        return;
      }
      messages.push(client.userMessage(q));
      inFlight = true;
      rl.pause();
      process.stdout.write("(thinking...) ");
      const startedAt = Date.now();
      const ticker = setInterval(() => {
        process.stdout.write(".");
      }, 1000);
      try {
        const response = await client.chat(messages, [ANSWER_TOOL], rebuilt.systemPrompt);
        clearInterval(ticker);
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        // Newline after the dots
        process.stdout.write("\n");
        const extracted = extractAnswer(response.toolCalls, response.text);
        const tag = extracted.kind === "unstructured" ? " (unstructured)" : "";
        console.log("");
        console.log(extracted.text + tag);
        console.log(
          `  [${elapsedSec}s · tokens: ${response.usage.inputTokens} in / ${response.usage.outputTokens} out` +
            (response.usage.cacheReadInputTokens
              ? `; ${response.usage.cacheReadInputTokens} cached`
              : "") +
            `]`,
        );
        console.log("");
        // Multi-turn: keep the assistant message; if it used `answer`,
        // append a matching tool_result via the client so the next turn
        // is provider-valid.
        messages.push(response.rawAssistantMessage);
        const answerCall = response.toolCalls.find((tc) => tc.name === "answer");
        if (answerCall) {
          messages.push(
            ...client.toolResultMessages([answerCall], [{ text: "" }]),
          );
        }
      } catch (err) {
        clearInterval(ticker);
        process.stdout.write("\n");
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`API error: ${msg}`);
      } finally {
        inFlight = false;
        rl.resume();
        rl.prompt();
      }
    });
    rl.on("close", () => {
      console.log("");
      resolveExit(0);
    });
    rl.on("SIGINT", () => {
      rl.close();
    });
  });
}

function peekRecordedModel(runDir: string): string {
  const text = readFileSync(resolve(runDir, "run.jsonl"), "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const evt = JSON.parse(line) as { type?: string; model?: string };
    if (evt.type === "run_start") return String(evt.model ?? "");
  }
  return "";
}

function peekRecordedDate(runDir: string): string {
  const text = readFileSync(resolve(runDir, "run.jsonl"), "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const evt = JSON.parse(line) as { type?: string; ts?: string };
    if (evt.type === "run_start") return String(evt.ts ?? "unknown date");
  }
  return "unknown date";
}
