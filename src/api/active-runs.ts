export interface ActiveRunInfo {
  id: string; // = cardId (last-run-wins)
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

  unregister(id: string): void {
    this.runs.delete(id);
  }

  recordFrame(id: string, frame: { data: string; width: number; height: number }): void {
    const snap = this.runs.get(id);
    if (!snap) return;
    snap.lastFrame = frame;
  }

  recordProgress(id: string, message: string): void {
    const snap = this.runs.get(id);
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

  getSnapshot(id: string): RunSnapshot | null {
    return this.runs.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.runs.has(id);
  }
}
