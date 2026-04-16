export interface ActiveRunInfo {
  /**
   * Primary key for the run. Self-describing: `<cardId>_<YYYYMMDDTHHMMSSZ>_<nonce>`
   * (see `makeRunId`). Concurrent runs of the same card now have distinct
   * registry entries.
   */
  id: string;
  /** The card id this run is exercising. Stored as payload metadata so
   * UIs can still group/filter by card without using it as the registry key. */
  cardId: string;
  title: string;
  target: string;
  model: string;
  startedAt: number; // ms since epoch
}

export interface RunSnapshot {
  info: ActiveRunInfo;
  lastFrame: { data: string; width: number; height: number } | null;
  progressLog: string[]; // ring buffer, most recent last
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
}
