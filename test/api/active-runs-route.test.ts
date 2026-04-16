import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { ActiveRunRegistry } from "../../src/api/active-runs";
import { activeRunRoutes } from "../../src/api/routes/active-runs";

describe("Active Runs API", () => {
  function makeApp() {
    const registry = new ActiveRunRegistry();
    const app = new Hono();
    app.route("/api/runs/active", activeRunRoutes(registry));
    return { app, registry };
  }

  // Realistic-shape runId for tests; the registry treats it as opaque.
  const RUN_ID = "story-001_20260416T142301Z_k3xm";

  test("GET /api/runs/active returns empty when nothing running", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/runs/active");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: [] });
  });

  test("GET /api/runs/active returns registered runs with both id (runId) and cardId", async () => {
    const { app, registry } = makeApp();
    registry.register({
      id: RUN_ID,
      cardId: "story-001",
      title: "Test",
      target: "http://localhost:3000",
      model: "claude-sonnet-4-6",
      startedAt: 123,
    });
    const res = await app.request("/api/runs/active");
    const body = await res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].id).toBe(RUN_ID);
    expect(body.runs[0].cardId).toBe("story-001");
  });

  test("GET /api/runs/active/:id/snapshot returns snapshot keyed by runId", async () => {
    const { app, registry } = makeApp();
    registry.register({
      id: RUN_ID,
      cardId: "story-001",
      title: "Test",
      target: "http://localhost:3000",
      model: "claude-sonnet-4-6",
      startedAt: 123,
    });
    registry.recordProgress(RUN_ID, "hello");
    registry.recordFrame(RUN_ID, { data: "AAA", width: 10, height: 20 });

    const res = await app.request(`/api/runs/active/${RUN_ID}/snapshot`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.info.id).toBe(RUN_ID);
    expect(body.info.cardId).toBe("story-001");
    expect(body.lastFrame).toEqual({ data: "AAA", width: 10, height: 20 });
    expect(body.progressLog).toEqual(["hello"]);
  });

  test("GET /api/runs/active/:id/snapshot returns 404 when not running", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/runs/active/nope/snapshot");
    expect(res.status).toBe(404);
  });
});
