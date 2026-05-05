interface WsLike {
  send(data: string): void;
  readyState: number;
  close(code?: number, reason?: string): void;
}

export class RunBroadcaster {
  private clients = new Map<string, Set<WsLike>>();

  addClient(runId: string, ws: WsLike) {
    if (!this.clients.has(runId)) {
      this.clients.set(runId, new Set());
    }
    this.clients.get(runId)!.add(ws);
  }

  removeClient(runId: string, ws: WsLike) {
    this.clients.get(runId)?.delete(ws);
  }

  send(runId: string, message: Record<string, unknown>) {
    const clients = this.clients.get(runId);
    if (!clients) return;

    const data = JSON.stringify(message);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(data);
      } else {
        clients.delete(ws);
      }
    }
  }

  /** Close every connected client with the given code+reason and forget
   * them. Used by graceful shutdown (PRI-1477) to send a 1001 "going
   * away" before the daemon exits. Per-client errors are swallowed so a
   * single bad socket doesn't block the rest. */
  closeAll(code: number, reason: string): void {
    for (const set of this.clients.values()) {
      for (const ws of set) {
        try { ws.close(code, reason); } catch { /* per-client errors ignored */ }
      }
    }
    this.clients.clear();
  }
}
