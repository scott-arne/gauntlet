import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../../src/api/server";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Scenarios API", () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "vet-api-"));
    const storiesDir = join(dataDir, "stories");
    mkdirSync(storiesDir, { recursive: true });

    writeFileSync(
      join(storiesDir, "story-001-test.md"),
      "---\nid: story-001\ntitle: Test story\nstatus: draft\ntags: core\n---\n\nA test story.\n\n## Acceptance Criteria\n- Something works\n"
    );

    writeFileSync(
      join(storiesDir, "story-002-another.md"),
      "---\nid: story-002\ntitle: Another story\nstatus: ready\n---\n\nAnother story.\n"
    );

    app = createApp(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("GET /scenarios lists all scenarios", async () => {
    const res = await app.request("/scenarios");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("story-001");
    expect(body[1].id).toBe("story-002");
  });

  test("GET /scenarios/:id returns single scenario", async () => {
    const res = await app.request("/scenarios/story-001");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("Test story");
    expect(body.acceptanceCriteria).toHaveLength(1);
  });

  test("GET /scenarios/:id returns 404 for missing", async () => {
    const res = await app.request("/scenarios/story-999");
    expect(res.status).toBe(404);
  });

  test("PUT /scenarios/:id updates scenario", async () => {
    const res = await app.request("/scenarios/story-001", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");

    // Verify persisted
    const getRes = await app.request("/scenarios/story-001");
    const getBody = await getRes.json();
    expect(getBody.status).toBe("ready");
  });

  test("GET /scenarios returns empty array when stories dir doesn't exist", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "vet-no-stories-"));
    const emptyApp = createApp(emptyDir);
    const res = await emptyApp.request("/scenarios");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
    rmSync(emptyDir, { recursive: true, force: true });
  });

  test("POST /scenarios/:id/approve sets status to ready", async () => {
    const res = await app.request("/scenarios/story-001/approve", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
  });
});
