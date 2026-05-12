import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runRoutes } from "../../src/api/routes/run";
import { activeRunRoutes } from "../../src/api/routes/active-runs";
import { ActiveRunRegistry } from "../../src/api/active-runs";
import { createApp } from "../../src/api/server";
import { loadConfig, validateRunBody } from "../../src/config";
import { gauntletPath } from "../../src/paths";

const STORY_MD = `---
id: cap-test-card
title: Cap test card
status: draft
tags: core
---

A test story.

## Acceptance Criteria
- something
`;

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gauntlet-caps-"));
  const stories = gauntletPath(root, "stories");
  mkdirSync(stories, { recursive: true });
  writeFileSync(join(stories, "cap-test-card.md"), STORY_MD);
  return root;
}

describe("validateRunBody: body.turns is rejected", () => {
  test("rejects any body.turns value with a clear 400-suitable error", () => {
    expect(() => validateRunBody({ target: "http://x", turns: 5 }, {}))
      .toThrow(/`turns` is no longer accepted/);
  });

  test("accepts body without turns", () => {
    expect(() => validateRunBody({ target: "http://x" }, {})).not.toThrow();
  });
});

describe("loadConfig: GAUNTLET_MAX_TIME and GAUNTLET_MAX_STUCK_RETRIES", () => {
  test("default budget is 5 minutes; default stuck retries is 5", () => {
    const c = loadConfig({}, {} as NodeJS.ProcessEnv);
    expect(c.defaultBudgetMs).toBe(300_000);
    expect(c.defaultMaxStuckRetries).toBe(5);
  });

  test("GAUNTLET_MAX_TIME accepts duration strings", () => {
    const c = loadConfig({}, { GAUNTLET_MAX_TIME: "30s" } as NodeJS.ProcessEnv);
    expect(c.defaultBudgetMs).toBe(30_000);
  });

  test("GAUNTLET_MAX_STUCK_RETRIES accepts positive integer", () => {
    const c = loadConfig({}, { GAUNTLET_MAX_STUCK_RETRIES: "3" } as NodeJS.ProcessEnv);
    expect(c.defaultMaxStuckRetries).toBe(3);
  });

  test("rejects GAUNTLET_MAX_STUCK_RETRIES with trailing garbage like '3abc'", () => {
    expect(() =>
      loadConfig({ args: {} } as any, { GAUNTLET_MAX_STUCK_RETRIES: "3abc" } as NodeJS.ProcessEnv),
    ).toThrow(/GAUNTLET_MAX_STUCK_RETRIES.*3abc/);
  });

  test("rejects fractional GAUNTLET_MAX_STUCK_RETRIES", () => {
    expect(() =>
      loadConfig({ args: {} } as any, { GAUNTLET_MAX_STUCK_RETRIES: "3.5" } as NodeJS.ProcessEnv),
    ).toThrow(/GAUNTLET_MAX_STUCK_RETRIES.*3.5/);
  });

  test("CLI --max-time overrides env", () => {
    const c = loadConfig(
      { maxTime: "10s" } as any,
      { GAUNTLET_MAX_TIME: "5m" } as NodeJS.ProcessEnv,
    );
    expect(c.defaultBudgetMs).toBe(10_000);
  });

  test("invalid GAUNTLET_MAX_TIME throws with the offending value", () => {
    expect(() =>
      loadConfig({}, { GAUNTLET_MAX_TIME: "xyz" } as NodeJS.ProcessEnv),
    ).toThrow(/GAUNTLET_MAX_TIME.*xyz/);
  });
});

describe("PRI-1478: concurrency cap", () => {
  test("returns 429 + Retry-After when registry already at cap", async () => {
    const projectRoot = makeProjectRoot();
    try {
      const config = loadConfig({ projectRoot }, {
        GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6",
        GAUNTLET_MAX_CONCURRENT_RUNS: "2",
      } as NodeJS.ProcessEnv);
      const registry = new ActiveRunRegistry();
      registry.register({ id: "run-a", cardId: "x", title: "x", target: "http://x", model: "claude-sonnet-4-6", startedAt: 1, status: "running" });
      registry.register({ id: "run-b", cardId: "x", title: "x", target: "http://x", model: "claude-sonnet-4-6", startedAt: 2, status: "running" });

      const app = new Hono();
      app.route("/api/run", runRoutes(config, undefined, undefined, registry));

      const res = await app.request("/api/run/cap-test-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "http://x" }),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("5");
      const body = await res.json() as { error: string; cap: number };
      expect(body.error).toBe("too_many_runs");
      expect(body.cap).toBe(2);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("accepts the request when registry has fewer than cap entries", async () => {
    const projectRoot = makeProjectRoot();
    try {
      const config = loadConfig({ projectRoot }, {
        GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6",
        GAUNTLET_MAX_CONCURRENT_RUNS: "10",
      } as NodeJS.ProcessEnv);
      const registry = new ActiveRunRegistry();
      // Sub-cap; the request should not 429.
      registry.register({ id: "run-a", cardId: "x", title: "x", target: "http://x", model: "claude-sonnet-4-6", startedAt: 1, status: "running" });

      const app = new Hono();
      app.route("/api/run", runRoutes(config, undefined, undefined, registry));

      const res = await app.request("/api/run/cap-test-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "http://x" }),
      });
      expect(res.status).not.toBe(429);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("PRI-1478: active-runs target truncation", () => {
  test("truncates target longer than cap to <cap>... in list view", async () => {
    const registry = new ActiveRunRegistry();
    const longTarget = "http://" + "x".repeat(2000);
    registry.register({ id: "run-a", cardId: "x", title: "x", target: longTarget, model: "claude-sonnet-4-6", startedAt: 1, status: "running" });

    const app = new Hono();
    app.route("/api/runs/active", activeRunRoutes(registry, 1024));

    const res = await app.request("/api/runs/active");
    expect(res.status).toBe(200);
    const body = await res.json() as { runs: Array<{ target: string }> };
    expect(body.runs[0].target.length).toBe(1024 + 3); // cap + "..."
    expect(body.runs[0].target.endsWith("...")).toBe(true);
  });

  test("does not truncate target shorter than cap", async () => {
    const registry = new ActiveRunRegistry();
    const shortTarget = "http://localhost:3000";
    registry.register({ id: "run-a", cardId: "x", title: "x", target: shortTarget, model: "claude-sonnet-4-6", startedAt: 1, status: "running" });

    const app = new Hono();
    app.route("/api/runs/active", activeRunRoutes(registry, 1024));

    const res = await app.request("/api/runs/active");
    const body = await res.json() as { runs: Array<{ target: string }> };
    expect(body.runs[0].target).toBe(shortTarget);
  });

  test("snapshot endpoint returns full target even when list view truncated", async () => {
    const registry = new ActiveRunRegistry();
    const longTarget = "http://" + "x".repeat(2000);
    registry.register({ id: "run-a", cardId: "x", title: "x", target: longTarget, model: "claude-sonnet-4-6", startedAt: 1, status: "running" });

    const app = new Hono();
    app.route("/api/runs/active", activeRunRoutes(registry, 1024));

    const res = await app.request("/api/runs/active/run-a/snapshot");
    expect(res.status).toBe(200);
    const body = await res.json() as { info: { target: string } };
    expect(body.info.target).toBe(longTarget);
  });
});

describe("PRI-1478: body size cap (Hono bodyLimit middleware)", () => {
  test("returns 413 + body_too_large envelope when request body exceeds cap", async () => {
    const projectRoot = makeProjectRoot();
    try {
      const config = loadConfig({ projectRoot }, {
        GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6",
        GAUNTLET_MAX_REQUEST_BODY_SIZE: "1024",
      } as NodeJS.ProcessEnv);
      const app = createApp(config);
      const huge = "x".repeat(2048);
      const reqBody = JSON.stringify({ target: "http://x", padding: huge });
      const res = await app.request("/api/run/cap-test-card", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Hono's bodyLimit short-circuits on Content-Length; real
          // clients always set it, but app.request doesn't auto-set
          // it from the body string.
          "Content-Length": String(reqBody.length),
        },
        body: reqBody,
      });
      expect(res.status).toBe(413);
      const resBody = await res.json() as { error: string; cap: number };
      expect(resBody.error).toBe("body_too_large");
      expect(resBody.cap).toBe(1024);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("accepts request body under the cap", async () => {
    const projectRoot = makeProjectRoot();
    try {
      const config = loadConfig({ projectRoot }, {
        GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6",
        GAUNTLET_MAX_REQUEST_BODY_SIZE: "10240",
      } as NodeJS.ProcessEnv);
      const app = createApp(config);
      const small = JSON.stringify({ target: "http://x" });
      const res = await app.request("/api/run/cap-test-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: small,
      });
      expect(res.status).not.toBe(413);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("PRI-1478: config env var parsing", () => {
  test("loadConfig populates caps with defaults when env unset", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "caps-cfg-"));
    try {
      const c = loadConfig({ projectRoot }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
      expect(c.maxRequestBodySize).toBe(1024 * 1024);
      expect(c.maxConcurrentRuns).toBe(4);
      expect(c.activeRunTargetMaxBytes).toBe(1024);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("env overrides take effect", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "caps-cfg-"));
    try {
      const c = loadConfig({ projectRoot }, {
        GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6",
        GAUNTLET_MAX_REQUEST_BODY_SIZE: "65536",
        GAUNTLET_MAX_CONCURRENT_RUNS: "8",
        GAUNTLET_ACTIVE_RUN_TARGET_MAX_BYTES: "2048",
      } as NodeJS.ProcessEnv);
      expect(c.maxRequestBodySize).toBe(65536);
      expect(c.maxConcurrentRuns).toBe(8);
      expect(c.activeRunTargetMaxBytes).toBe(2048);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("rejects non-numeric env values with a clear error", () => {
    expect(() =>
      loadConfig({}, {
        GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6",
        GAUNTLET_MAX_REQUEST_BODY_SIZE: "not-a-number",
      } as NodeJS.ProcessEnv)
    ).toThrow(/GAUNTLET_MAX_REQUEST_BODY_SIZE/);
  });
});
