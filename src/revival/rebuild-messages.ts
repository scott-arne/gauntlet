import { readFileSync } from "fs";
import { join } from "path";
import type { LLMClient, ToolCall, ToolDefinition, ToolResult } from "../models/provider";
import { pushAssistantTurn, textResult } from "../models/provider";
import { buildRevivalAddendum } from "./system-prompt-addendum";
import { getAdapterToolDefinitionsByName } from "../adapters/registry";
import {
  REPORT_TOOL,
  synthesizeFilledAssistantMessage,
  synthesizeTruncatedAssistantStub,
} from "../agent/agent";

/**
 * The subset of LLMClient that rebuildMessages depends on. Both
 * userMessage and toolResultMessages are pure (no API calls). Tests
 * supply a fake; production passes a real provider client so the
 * rebuilt message shape is provider-native.
 */
export type MessageBuilder = Pick<LLMClient, "userMessage" | "toolResultMessages">;

export interface RebuildResult {
  systemPrompt: string;
  messages: unknown[];
  toolDefs: ToolDefinition[];
  modelId: string;
  adapterName: string;
  warnings: string[];
}

interface RawEvent {
  eventId: number;
  parentEventId: number;
  ts: string;
  type: string;
  [k: string]: unknown;
}

export function rebuildMessages(
  runDir: string,
  client: MessageBuilder,
  upToTurn?: number,
): RebuildResult {
  const path = join(runDir, "run.jsonl");
  const text = readFileSync(path, "utf8");
  const events: RawEvent[] = text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RawEvent);

  if (events.length === 0) {
    throw new Error(`Run ${runDir} produced no events`);
  }

  const runStart = events.find((e) => e.type === "run_start");
  if (!runStart) throw new Error(`Run ${runDir} has no run_start event`);
  const modelId = String(runStart.model ?? "");
  const adapterName = String(runStart.adapter ?? "");

  const sysEvt = events.find((e) => e.type === "system_prompt");
  if (!sysEvt) throw new Error(`Run ${runDir} has no system_prompt event`);
  const systemPromptBody = String(sysEvt.content ?? "");

  const toolDefsEvt = events.find((e) => e.type === "tool_definitions");
  const warnings: string[] = [];
  const fallback = !toolDefsEvt;
  let toolDefs: ToolDefinition[];
  if (toolDefsEvt) {
    toolDefs = toolDefsEvt.tools as ToolDefinition[];
  } else {
    // Old run without tool_definitions event: reconstruct from the live
    // adapter + REPORT_TOOL. If the adapter is no longer registered
    // we throw — silent fallback to "no tools" would mislead the model.
    toolDefs = [...getAdapterToolDefinitionsByName(adapterName), REPORT_TOOL];
    warnings.push(
      "No tool_definitions event in this run's run.jsonl (old format); reconstructed from current adapter code. Schemas may have drifted.",
    );
  }

  const systemPrompt =
    systemPromptBody + buildRevivalAddendum(toolDefs, { fallback });

  const turnsSeen = events
    .map((e) => (typeof e.turn === "number" ? (e.turn as number) : undefined))
    .filter((t): t is number => t !== undefined);
  const lastTurn = turnsSeen.length > 0 ? Math.max(...turnsSeen) : 0;

  if (upToTurn !== undefined && upToTurn > lastTurn) {
    throw new Error(
      `--turn ${upToTurn} out of range; run ended at turn ${lastTurn}`,
    );
  }

  const cutoff = upToTurn ?? lastTurn;

  const messages: unknown[] = [];

  // Initial user message (turn 0)
  const initialUser = events.find(
    (e) => e.type === "user_message" && (e.turn === 0 || e.turn === undefined),
  );
  if (initialUser) {
    messages.push(client.userMessage(String(initialUser.content ?? "")));
  }

  const turnNumbers = Array.from(
    new Set(
      events
        .filter(
          (e) =>
            (e.turn as number | undefined) !== undefined &&
            (e.turn as number) >= 1 &&
            (e.turn as number) <= cutoff,
        )
        .map((e) => e.turn as number),
    ),
  ).sort((a, b) => a - b);

  for (const turn of turnNumbers) {
    const turnEvents = events.filter((e) => e.turn === turn);
    const llmResp = turnEvents.find((e) => e.type === "llm_response");
    const toolResultEvts = turnEvents.filter((e) => e.type === "tool_result");
    const toolCallEvts = turnEvents.filter((e) => e.type === "tool_call");
    const userMsg = turnEvents.find((e) => e.type === "user_message");

    // A user_message at a turn with NO tool_result group is one of three
    // shapes, distinguished by the turn's own llm_response:
    //  - max_tokens recovery (PRI-2160): the live loop DISCARDED the
    //    truncated response, pushed a stub, then the nudge — replay
    //    stub-then-user, never the truncated raw (partial thinking
    //    blocks don't round-trip).
    //  - empty-response nudge (PRI-1864): the live loop pushed a
    //    stub-filled assistant turn, then the nudge.
    //  - grace/forced final report: the reminder is a standalone user
    //    turn that comes BEFORE the assistant response.
    if (userMsg && toolResultEvts.length === 0) {
      // The recovery shapes are identified by the event rows the live
      // loop wrote alongside them — a grace turn whose response happens
      // to be empty has the same llm_response shape but no such event,
      // and must keep its user-before-assistant order.
      const hasEvent = (name: string) =>
        turnEvents.some((e) => e.type === "event" && e.name === name);
      if (llmResp && llmResp.stopReason === "max_tokens" && hasEvent("stopped_max_tokens")) {
        pushAssistantTurn(messages, synthesizeTruncatedAssistantStub(llmResp.rawAssistantMessage));
        messages.push(client.userMessage(String(userMsg.content ?? "")));
        continue;
      }
      if (llmResp && hasEvent("empty_response_nudge")) {
        pushAssistantTurn(messages, synthesizeFilledAssistantMessage(llmResp.rawAssistantMessage));
        messages.push(client.userMessage(String(userMsg.content ?? "")));
        continue;
      }
      messages.push(client.userMessage(String(userMsg.content ?? "")));
    }

    if (llmResp) {
      pushAssistantTurn(messages, llmResp.rawAssistantMessage);
    }

    if (toolResultEvts.length > 0) {
      const calls: ToolCall[] = toolCallEvts.map((tc) => ({
        id: String(tc.toolUseId),
        name: String(tc.name),
        arguments: (tc.arguments as Record<string, unknown>) ?? {},
      }));
      const results: ToolResult[] = toolResultEvts.map((tr) =>
        rebuildToolResult(tr, runDir, warnings),
      );
      // A user_message at this turn co-existing with tool_results is the
      // reflection-checkpoint reminder. The provider's toolResultMessages
      // weaves it correctly (Anthropic: trailing text block; OpenAI:
      // separate user message after the per-call tool messages).
      const extraUserText = userMsg
        ? String(userMsg.content ?? "")
        : undefined;
      messages.push(...client.toolResultMessages(calls, results, extraUserText));
    }
  }

  // Terminal-turn stub synthesis (spec §"Terminal-turn handling"). Source
  // of truth is the llm_response events, not the rebuilt messages — the
  // rebuilt assistant messages are in provider-native shape, while the
  // logged toolCalls are provider-neutral.
  const includedLlmResponses = events.filter(
    (e) => e.type === "llm_response" && (e.turn as number) <= cutoff,
  );
  const finalLlmResp = includedLlmResponses[includedLlmResponses.length - 1];
  if (finalLlmResp) {
    const finalCalls = (finalLlmResp.toolCalls as ToolCall[]) ?? [];
    if (finalCalls.length > 0) {
      const executedIds = new Set(
        events
          .filter(
            (e) =>
              e.type === "tool_result" &&
              (e.turn as number) === (finalLlmResp.turn as number),
          )
          .map((e) => String(e.toolUseId)),
      );
      const unmatched = finalCalls.filter((c) => !executedIds.has(c.id));
      if (unmatched.length > 0) {
        const stubResults: ToolResult[] = unmatched.map(() =>
          textResult("[revival: tool was not executed during the original run]"),
        );
        messages.push(...client.toolResultMessages(unmatched, stubResults));
      }
    }
  }

  return { systemPrompt, messages, toolDefs, modelId, adapterName, warnings };
}

/**
 * Reconstruct an in-memory ToolResult from a logged tool_result event,
 * rehydrating spilled image / text / capture content from disk.
 */
function rebuildToolResult(
  tr: RawEvent,
  runDir: string,
  warnings: string[],
): ToolResult {
  // Reconstruct the variant from the per-field signals on disk. The
  // run.jsonl rows don't carry an explicit `kind`; we infer from
  // which fields the original producer set:
  //   - capturePath set → capture variant (TUI read_screen)
  //   - image set       → image variant   (web screenshot)
  //   - else            → text variant    (most paths)
  // textTruncated+artifact rehydrates `text` for any variant.
  let text = String(tr.text ?? "");
  const textTruncated = tr.textTruncated === true;
  const artifactRel = tr.artifact as string | undefined;
  if (textTruncated && artifactRel) {
    text = readFileSync(join(runDir, artifactRel), "utf8");
  }
  const capturePathRel = tr.capturePath as string | undefined;
  if (capturePathRel) {
    text = readFileSync(join(runDir, capturePathRel), "utf8");
    return { kind: "capture", text, capturePath: capturePathRel };
  }

  const imageRel = tr.image as string | undefined;
  if (imageRel) {
    let mediaType = tr.mediaType as string | undefined;
    if (!mediaType) {
      mediaType = "image/png";
      warnings.push(
        `tool_result for ${String(tr.name)} had no mediaType; defaulting to image/png (older run.jsonl format)`,
      );
    }
    const data = readFileSync(join(runDir, imageRel)).toString("base64");
    return {
      kind: "image",
      text,
      image: { data, mediaType },
      imagePath: imageRel,
    };
  }

  return textResult(text);
}
