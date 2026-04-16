import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../../src/api/server";
import { loadConfig } from "../../src/config";
import { gauntletPath } from "../../src/paths";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const makeApp = (projectRoot: string, uiDir?: string) =>
  createApp(loadConfig({ projectRoot }, {} as NodeJS.ProcessEnv), uiDir);

describe("Scenarios API", () => {
  let projectRoot: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-api-"));
    const storiesDir = gauntletPath(projectRoot, "stories");
    mkdirSync(storiesDir, { recursive: true });

    writeFileSync(
      join(storiesDir, "story-001-test.md"),
      "---\nid: story-001\ntitle: Test story\nstatus: draft\ntags: core\n---\n\nA test story.\n\n## Acceptance Criteria\n- Something works\n"
    );

    writeFileSync(
      join(storiesDir, "story-002-another.md"),
      "---\nid: story-002\ntitle: Another story\nstatus: ready\n---\n\nAnother story.\n"
    );

    app = makeApp(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("GET /api/scenarios lists all scenarios", async () => {
    const res = await app.request("/api/scenarios");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("story-001");
    expect(body[1].id).toBe("story-002");
  });

  test("GET /api/scenarios/:id returns single scenario", async () => {
    const res = await app.request("/api/scenarios/story-001");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("Test story");
    expect(body.acceptanceCriteria).toHaveLength(1);
  });

  test("GET /api/scenarios/:id returns 404 for missing", async () => {
    const res = await app.request("/api/scenarios/story-999");
    expect(res.status).toBe(404);
  });

  test("PUT /api/scenarios/:id updates scenario", async () => {
    const res = await app.request("/api/scenarios/story-001", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");

    // Verify persisted
    const getRes = await app.request("/api/scenarios/story-001");
    const getBody = await getRes.json();
    expect(getBody.status).toBe("ready");
  });

  test("GET /api/scenarios returns empty array when stories dir doesn't exist", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "gauntlet-no-stories-"));
    const emptyApp = makeApp(emptyDir);
    const res = await emptyApp.request("/api/scenarios");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
    rmSync(emptyDir, { recursive: true, force: true });
  });

  test("POST /api/scenarios creates a new card", async () => {
    const res = await app.request("/api/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "new-card",
        title: "New card",
        status: "draft",
        tags: ["test"],
        description: "A new card",
        acceptanceCriteria: ["Works correctly"],
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe("new-card");
    expect(data.title).toBe("New card");

    // Verify persisted
    const getRes = await app.request("/api/scenarios/new-card");
    expect(getRes.status).toBe(200);
  });

  test("POST /api/scenarios rejects path traversal in id", async () => {
    const res = await app.request("/api/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "../../../etc/evil",
        title: "Traversal attempt",
        description: "",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid id");
  });

  test("POST /api/scenarios returns 400 for missing id", async () => {
    const res = await app.request("/api/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No id" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/scenarios returns 409 for duplicate id", async () => {
    const res = await app.request("/api/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "story-001",
        title: "Duplicate",
        description: "",
        acceptanceCriteria: [],
      }),
    });
    expect(res.status).toBe(409);
  });

  test("DELETE /api/scenarios/:id deletes a card", async () => {
    const res = await app.request("/api/scenarios/story-001", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const getRes = await app.request("/api/scenarios/story-001");
    expect(getRes.status).toBe(404);
  });

  test("DELETE /api/scenarios/:id returns 404 for unknown card", async () => {
    const res = await app.request("/api/scenarios/nonexistent", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  test("POST /api/scenarios/:id/approve sets status to ready", async () => {
    const res = await app.request("/api/scenarios/story-001/approve", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
  });

  test("POST rejects tags as a string (wrong shape)", async () => {
    const res = await app.request("/api/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bad-tags", title: "Bad tags", tags: "smoke" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("tags");
  });

  test("POST rejects acceptanceCriteria as non-array", async () => {
    const res = await app.request("/api/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bad-ac", title: "Bad AC", acceptanceCriteria: "one thing" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("acceptanceCriteria");
  });

  test("POST rejects non-string title", async () => {
    const res = await app.request("/api/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bad-title", title: 42 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("title");
  });

  test("POST accepts arbitrary status (no value gating)", async () => {
    const res = await app.request("/api/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "weird-status", title: "Weird", status: "whatever-i-want" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("whatever-i-want");
  });

  test("PUT rejects id in body", async () => {
    const res = await app.request("/api/scenarios/story-001", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "renamed" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("id");
  });

  test("POST rejects malformed JSON with 400", async () => {
    const res = await app.request("/api/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  test("PUT rejects non-array tags", async () => {
    const res = await app.request("/api/scenarios/story-001", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: "smoke" }),
    });
    expect(res.status).toBe(400);
  });
});
