interface WsLike {
  send(data: string): void;
  readyState: number;
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
}
