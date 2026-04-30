import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { RunBroadcaster } from "./ws";
import type { ActiveRunRegistry } from "./active-runs";
import type { RunSetBroadcaster } from "./run-set-broadcaster";

interface WsLike {
  send(data: string): void;
  readyState: number;
}

/**
 * Handle a new WebSocket connection for a run. Subscribes the client to
 * the broadcaster first (so no terminal event slips through the gap),
 * then sends either a `snapshot` (if the run is live in the registry) or
 * a `gone` (if not).
 *
 * Additionally, when a `run.jsonl` exists on disk for the run, emits a
 * `transcriptSnapshot` containing the full prior event stream (spec
 * §6.3). Fires independently of the legacy `snapshot`/`gone` branch:
 * both can fire for the same connection and are consumed by different
 * frontend views.
 */
export function handleWsOpen(
  registry: ActiveRunRegistry | undefined,
  broadcaster: RunBroadcaster,
  runId: string,
  ws: WsLike,
  resultsRoot?: string,
): void {
  broadcaster.addClient(runId, ws);
  const snap = registry?.getSnapshot(runId);
  if (snap) {
    ws.send(JSON.stringify({
      type: "snapshot",
      lastFrame: snap.lastFrame,
      progressLog: snap.progressLog,
    }));
  } else {
    ws.send(JSON.stringify({ type: "gone" }));
  }

  // Best-effort transcript snapshot. Runs with no `run.jsonl` on disk
  // (legacy or very early live runs) simply don't get this message.
  if (resultsRoot) {
    const jsonlPath = join(resultsRoot, runId, "run.jsonl");
    if (existsSync(jsonlPath)) {
      try {
        const raw = readFileSync(jsonlPath, "utf8");
        const events = raw
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try { return JSON.parse(l); } catch { return null; }
          })
          .filter((x) => x !== null);
        if (events.length > 0) {
          ws.send(JSON.stringify({ type: "transcriptSnapshot", events }));
        }
      } catch {
        // silent; this is best-effort
      }
    }
  }
}

/**
 * Handle a new WebSocket connection for a run set. Subscribes the client to
 * the setBroadcaster first, then sends a `snapshot` of the current set
 * manifest if one already exists on disk.
 */
export function handleSetWsOpen(
  setBroadcaster: RunSetBroadcaster,
  runSetId: string,
  ws: WsLike,
  gauntletRoot: string,
): void {
  setBroadcaster.addClient(runSetId, ws);

  // Send initial snapshot if the set already has a manifest on disk.
  const path = join(gauntletRoot, "run-sets", runSetId, "set.json");
  if (existsSync(path)) {
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      ws.send(JSON.stringify({ kind: "snapshot", manifest }));
    } catch { /* ignore */ }
  }
}
