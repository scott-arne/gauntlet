import { mkdirSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";

export type BrowserEventCategory =
  | "console"
  | "exception"
  | "log"
  | "network-ws";

export type ActionObserver = (
  action: string,
  params: Record<string, unknown>,
) => void;

export type EventObserver = (event: Record<string, unknown>) => void;

export interface RunStartFields {
  runId: string;
  cardId: string;
  target: string | undefined;
  provider: string;
  model: string;
  adapter: string;
  maxTurns: number;
  toolTimeoutMs: number;
  contextTreeBytes: number;
}

export interface LlmResponseFields {
  turn: number;
  stopReason: string;
  text: string;
  thinking: Array<{ text: string; signature?: string }>;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  rawAssistantMessage: unknown;
}

export interface ToolResultFields {
  turn: number;
  toolUseId: string;
  name: string;
  durationMs: number;
  text: string;
  image?: string;            // relative path
  artifact?: string;         // relative path
  textTruncated?: true;
  textBytes?: number;
  error: boolean;
}

export interface RunEndFields {
  status: string;
  summary: string;
  reasoning: string;
  observationCount: number;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    turns: number;
  };
}

const INLINE_TEXT_LIMIT = 32 * 1024;

export class EvidenceLogger {
  private outDir: string;
  private screenshotCount = 0;
  private artifactCount = 0;
  private _screenshots: string[] = [];
  private _artifacts: string[] = [];
  private observers: Set<ActionObserver> = new Set();
  private eventObservers: Set<EventObserver> = new Set();
  private eventCounter = 0;
  private lastEventId = 0;

  constructor(outDir: string) {
    this.outDir = outDir;
    mkdirSync(join(outDir, "screenshots"), { recursive: true });
    mkdirSync(join(outDir, "artifacts"), { recursive: true });
  }

  get screenshots(): string[] { return [...this._screenshots]; }
  get artifacts(): string[] { return [...this._artifacts]; }
  get logPath(): string { return "run.jsonl"; }

  addObserver(fn: ActionObserver): () => void {
    this.observers.add(fn);
    return () => { this.observers.delete(fn); };
  }

  // A misbehaving observer (one that throws) will not prevent other observers
  // from receiving the action.
  private notifyObservers(action: string, params: Record<string, unknown>): void {
    for (const fn of this.observers) {
      try { fn(action, params); } catch { /* isolated */ }
    }
  }

  // Second, independent observer channel (spec §6.3). Delivers the full
  // structured entry (eventId, parentEventId, ts, type, and body fields)
  // that was just written to run.jsonl. The legacy action-observer
  // channel is unchanged — both fire side-by-side.
  addEventObserver(fn: EventObserver): () => void {
    this.eventObservers.add(fn);
    return () => { this.eventObservers.delete(fn); };
  }

  private notifyEventObservers(event: Record<string, unknown>): void {
    for (const fn of this.eventObservers) {
      try { fn(event); } catch { /* isolated */ }
    }
  }

  private writeEvent(type: string, body: Record<string, unknown>): number {
    this.eventCounter += 1;
    const eventId = this.eventCounter;
    const entry = {
      eventId,
      parentEventId: this.lastEventId,
      ts: new Date().toISOString(),
      type,
      ...body,
    };
    appendFileSync(join(this.outDir, "run.jsonl"), JSON.stringify(entry) + "\n");
    this.lastEventId = eventId;
    this.notifyEventObservers(entry);
    return eventId;
  }

  logRunStart(fields: RunStartFields): void {
    this.writeEvent("run_start", { ...fields });
  }

  logSystemPrompt(content: string): void {
    this.writeEvent("system_prompt", { content });
  }

  logUserMessage(turn: number, content: string): void {
    this.writeEvent("user_message", { turn, content });
  }

  logLlmRequest(turn: number, messageCount: number): void {
    this.writeEvent("llm_request", { turn, messageCount });
  }

  logLlmResponse(fields: LlmResponseFields): void {
    this.writeEvent("llm_response", { ...fields });
  }

  logToolCall(fields: {
    turn: number;
    toolUseId: string;
    name: string;
    arguments: Record<string, unknown>;
  }): void {
    this.writeEvent("tool_call", { ...fields });
    // Fire observers so live consumers (WS broadcaster, registry) still see
    // per-tool progress. Shape matches the old adapter-side logAction call
    // that this emitter replaced, so the feed looks unchanged to readers.
    this.notifyObservers(fields.name, fields.arguments);
  }

  logToolResult(fields: ToolResultFields): void {
    let body: Record<string, unknown> = { ...fields };
    if (typeof fields.text === "string" && Buffer.byteLength(fields.text, "utf8") > INLINE_TEXT_LIMIT) {
      const bytes = Buffer.byteLength(fields.text, "utf8");
      const spilled = this.saveArtifact(fields.text, "txt");
      body = {
        ...body,
        text: `<spilled — see ${spilled}>`,
        textTruncated: true,
        textBytes: bytes,
        artifact: fields.artifact ?? spilled,
      };
      this.writeEvent("tool_result", body);
      this.logEvent("tool_result_text_oversize", {
        turn: fields.turn,
        toolName: fields.name,
        bytes,
        artifact: spilled,
      });
      return;
    }
    this.writeEvent("tool_result", body);
  }

  logEvent(name: string, data: Record<string, unknown>): void {
    this.writeEvent("event", { name, ...data });
    this.notifyObservers(name, data);
  }

  logRunEnd(fields: RunEndFields): void {
    this.writeEvent("run_end", { ...fields });
  }

  logBrowserEvent(
    category: BrowserEventCategory,
    data: Record<string, unknown>,
  ): void {
    const entry = {
      timestamp: new Date().toISOString(),
      category,
      ...data,
    };
    appendFileSync(
      join(this.outDir, `${category}.jsonl`),
      JSON.stringify(entry) + "\n",
    );
  }

  saveScreenshot(data: Buffer, name?: string): string {
    if (!name) {
      this.screenshotCount++;
      name = String(this.screenshotCount).padStart(3, "0");
    }
    const relativePath = `screenshots/${name}.png`;
    writeFileSync(join(this.outDir, relativePath), data);
    this._screenshots.push(relativePath);
    return relativePath;
  }

  saveArtifact(data: Buffer | string, ext: string): string {
    this.artifactCount++;
    const name = String(this.artifactCount).padStart(3, "0");
    const relativePath = `artifacts/${name}.${ext}`;
    writeFileSync(join(this.outDir, relativePath), data);
    this._artifacts.push(relativePath);
    return relativePath;
  }
}
