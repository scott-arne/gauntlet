import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "../../src/config";
import { runRoutes } from "../../src/api/routes/run";
import { ActiveRunRegistry } from "../../src/api/active-runs";
import { RunBroadcaster } from "../../src/api/ws";
import { RunSetBroadcaster } from "../../src/api/run-set-broadcaster";
import { CancelTokenRegistry } from "../../src/api/run-cancel";

const STORY_MD = `---
id: api-multi-pass-test
title: API multi-pass test
status: ready
tags: smoke
---
A trivial test card.

## Acceptance Criteria

- It should pass.
`;

let projectRoot: string;
let storiesDir: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-mp-api-"));
  storiesDir = join(projectRoot, ".gauntlet", "stories");
  mkdirSync(storiesDir, { recursive: true });
  writeFileSync(join(storiesDir, "api-multi-pass-test.md"), STORY_MD);
});

describe("POST /api/run/:id with passes > 1", () => {
  test("returns the new uniform response shape with N runIds", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const config = loadConfig({ projectRoot }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as any);
      const registry = new ActiveRunRegistry();
      const broadcaster = new RunBroadcaster();
      const setBroadcaster = new RunSetBroadcaster();
      const cancelTokens = new CancelTokenRegistry();
      const app = new Hono();
      app.route("/api/run", runRoutes(config, broadcaster, undefined, registry, setBroadcaster, cancelTokens));

      const res = await app.request("/api/run/api-multi-pass-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "stub", adapter: "cli", passes: 3 }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.kind).toBe("single");
      expect(body.passes).toBe(3);
      expect(body.runs).toHaveLength(3);
      expect(body.runs[0].attemptNumber).toBe(1);
      expect(body.runs[2].attemptNumber).toBe(3);
      expect(body.runSetId).toMatch(/^single_/);
    } finally {
      process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("solo run (passes omitted) returns the new shape with runSetId: null", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const config = loadConfig({ projectRoot }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as any);
      const registry = new ActiveRunRegistry();
      const app = new Hono();
      app.route("/api/run", runRoutes(config, undefined, undefined, registry));

      const res = await app.request("/api/run/api-multi-pass-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "stub", adapter: "cli" }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.runSetId).toBeNull();
      expect(body.passes).toBe(1);
      expect(body.runs).toHaveLength(1);
    } finally {
      process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("rejects passes outside [1, 50]", async () => {
    const config = loadConfig({ projectRoot }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as any);
    const app = new Hono();
    app.route("/api/run", runRoutes(config));

    const res = await app.request("/api/run/api-multi-pass-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "stub", passes: 51 }),
    });
    expect(res.status).toBe(400);
  });
});
