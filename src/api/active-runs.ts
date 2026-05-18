import type { CardId, RunId, RunSetId } from "../util/brands";

export interface ActiveRunInfo {
  /**
   * Primary key for the run. Self-describing: `<cardId>_<YYYYMMDDTHHMMSSZ>_<nonce>`
   * (see `makeRunId`). Concurrent runs of the same card now have distinct
   * registry entries.
   */
  id: RunId;
  /** The card id this run is exercising. Stored as payload metadata so
   * UIs can still group/filter by card without using it as the registry key. */
  cardId: CardId;
  title: string;
  target: string;
  model: string;
  startedAt: number; // ms since epoch
  status: "queued" | "running";
  /** Link back to the run set, if any. */
  runSetId?: RunSetId;
  /** 1-indexed attempt number when part of a run set. */
  attemptNumber?: number;
  /** Total passes in the run set. */
  passes?: number;
}

export interface RunSnapshot {
  info: ActiveRunInfo;
  lastFrame: { data: string; width: number; height: number } | null;
  progressLog: string[]; // ring buffer, most recent last
  /**
   * Cancellation controller for the in-flight agent loop. Set by the run
   * route at register time so `drainShutdown` can fire it on grace-window
   * expiry (PRI-1507). NOT part of the public `ActiveRunInfo` payload —
   * internal infrastructure, never serialized to clients.
   */
  abortController?: AbortController;
}

const PROGRESS_LOG_CAP = 200;

export class ActiveRunRegistry {
  private runs = new Map<string, RunSnapshot>();

  register(info: ActiveRunInfo): void {
    this.runs.set(info.id, {
      info,
      lastFrame: null,
      progressLog: [],
    });
  }

  /**
   * Remove the entry for `runId`. If `startedAt` is provided, only remove
   * it when the current entry's `startedAt` matches — this prevents a
   * slow finally block from clobbering a freshly-registered entry that
   * happens to share the same key (defensive: with runIds containing a
   * nonce, collisions are extremely unlikely, but the guard is cheap).
   */
  unregister(runId: string, startedAt?: number): void {
    const snap = this.runs.get(runId);
    if (!snap) return;
    if (startedAt !== undefined && snap.info.startedAt !== startedAt) return;
    this.runs.delete(runId);
  }

  /**
   * Transition a run's status (e.g. from "queued" to "running").
   */
  setStatus(runId: string, status: "queued" | "running"): void {
    const snap = this.runs.get(runId);
    if (snap) snap.info.status = status;
  }

  recordFrame(runId: string, frame: { data: string; width: number; height: number }): void {
    const snap = this.runs.get(runId);
    if (!snap) return;
    snap.lastFrame = frame;
  }

  recordProgress(runId: string, message: string): void {
    const snap = this.runs.get(runId);
    if (!snap) return;
    snap.progressLog.push(message);
    if (snap.progressLog.length > PROGRESS_LOG_CAP) {
      snap.progressLog.splice(0, snap.progressLog.length - PROGRESS_LOG_CAP);
    }
  }

  list(): ActiveRunInfo[] {
    return Array.from(this.runs.values())
      .map((s) => s.info)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  getSnapshot(runId: string): RunSnapshot | null {
    return this.runs.get(runId) ?? null;
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  /**
   * Attach an AbortController to an existing registry entry. No-op if the
   * runId is not currently registered — production callers must register
   * before attaching. See PRI-1507 spec §4.
   */
  attachAbortController(runId: string, ac: AbortController): void {
    const snap = this.runs.get(runId);
    if (!snap) return;
    snap.abortController = ac;
  }

  /**
   * Retrieve a run's AbortController for tests / callers that need to
   * verify attach succeeded.
   */
  getAbortController(runId: string): AbortController | undefined {
    return this.runs.get(runId)?.abortController;
  }

  /**
   * Fire `abort(reason)` on every registered controller whose signal is
   * not already aborted. Returns the count of controllers newly aborted
   * (a controller that was already aborted is not double-counted, even
   * though `AbortController.abort` is itself idempotent). Used by
   * `drainShutdown` (PRI-1507) when the grace window expires.
   */
  abortAll(reason: string): number {
    let fired = 0;
    for (const snap of this.runs.values()) {
      const ac = snap.abortController;
      if (!ac) continue;
      if (ac.signal.aborted) continue;
      ac.abort(reason);
      fired++;
    }
    return fired;
  }
}
