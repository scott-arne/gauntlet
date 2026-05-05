interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export class RunSetBroadcaster {
  private clients = new Map<string, Set<WsLike>>();

  addClient(runSetId: string, ws: WsLike): void {
    let set = this.clients.get(runSetId);
    if (!set) {
      set = new Set();
      this.clients.set(runSetId, set);
    }
    set.add(ws);
  }

  removeClient(runSetId: string, ws: WsLike): void {
    const set = this.clients.get(runSetId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.clients.delete(runSetId);
  }

  send(runSetId: string, message: Record<string, unknown>): void {
    const set = this.clients.get(runSetId);
    if (!set) return;
    const json = JSON.stringify(message);
    for (const ws of set) {
      if (ws.readyState === 1) {
        try { ws.send(json); } catch { /* swallow per-client errors */ }
      }
    }
  }

  /** Close every connected client with the given code+reason and forget
   * them. Used by graceful shutdown (PRI-1477) to send a 1001 "going
   * away" before the daemon exits. Per-client errors are swallowed. */
  closeAll(code: number, reason: string): void {
    for (const set of this.clients.values()) {
      for (const ws of set) {
        try { ws.close(code, reason); } catch { /* per-client errors ignored */ }
      }
    }
    this.clients.clear();
  }
}
