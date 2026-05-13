import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { anthropicToolResultMessages } from "../../src/models/anthropic";

export function makeRunDir(events: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-revival-"));
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  let lastId = 0;
  const chained = events.map((e, i) => {
    const eventId = (e.eventId as number) ?? i + 1;
    const parentEventId = (e.parentEventId as number) ?? lastId;
    lastId = eventId;
    return {
      eventId,
      parentEventId,
      ts: e.ts ?? new Date().toISOString(),
      ...e,
    };
  });
  writeFileSync(
    join(dir, "run.jsonl"),
    chained.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  return dir;
}

export function writeScreenshot(runDir: string, name: string, bytes: Buffer): string {
  const rel = `screenshots/${name}`;
  writeFileSync(join(runDir, rel), bytes);
  return rel;
}

export function writeArtifact(runDir: string, name: string, content: string): string {
  const rel = `artifacts/${name}`;
  writeFileSync(join(runDir, rel), content);
  return rel;
}

export function writeCapture(runDir: string, name: string, content: string): string {
  mkdirSync(join(runDir, "captures"), { recursive: true });
  const rel = `captures/${name}`;
  writeFileSync(join(runDir, rel), content);
  return rel;
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Tiny 1x1 PNG (transparent) — for image-rehydration tests. */
export const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAEAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

/**
 * Minimal LLMClient stand-in for rebuildMessages tests. Reuses the real
 * exported anthropicToolResultMessages so tests assert against the
 * provider-native Anthropic shape without depending on an API key.
 * chat() is intentionally absent — these tests never call it.
 */
export function makeFakeAnthropicClient(): {
  userMessage: (content: string) => unknown;
  toolResultMessages: typeof anthropicToolResultMessages;
} {
  return {
    userMessage: (content: string) => ({ role: "user", content }),
    toolResultMessages: anthropicToolResultMessages,
  };
}
