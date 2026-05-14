import { Hono } from "hono";

export interface CancelToken {
  cancelled: boolean;
}

export class CancelTokenRegistry {
  private tokens = new Map<string, CancelToken>();

  register(runId: string, token: CancelToken): void {
    this.tokens.set(runId, token);
  }

  unregister(runId: string): void {
    this.tokens.delete(runId);
  }

  get(runId: string): CancelToken | undefined {
    return this.tokens.get(runId);
  }

  /**
   * Mark every registered token cancelled. Returns the count of tokens
   * transitioning from cancelled=false → true (a token already cancelled
   * is not double-counted). Used by `drainShutdown` (PRI-1507) to gate
   * run-set loops from starting more attempts during the shutdown
   * patience window — without this, a multi-pass set whose attempt 1
   * was just aborted via AbortController would happily start attempt 2,
   * race-conditioning the stub writer.
   */
  cancelAll(): number {
    let fired = 0;
    for (const t of this.tokens.values()) {
      if (t.cancelled) continue;
      t.cancelled = true;
      fired++;
    }
    return fired;
  }
}

export function runCancelRoutes(registry: CancelTokenRegistry) {
  const router = new Hono();
  router.delete("/:runId", (c) => {
    const token = registry.get(c.req.param("runId"));
    if (!token) return c.json({ error: "not in flight" }, 404);
    token.cancelled = true;
    return c.json({ status: "cancelling" }, 202);
  });
  return router;
}
