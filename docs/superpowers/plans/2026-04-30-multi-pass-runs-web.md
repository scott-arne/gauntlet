# Multi-pass runs (Web + API) Implementation Plan — Phase B

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layer multi-pass support onto the HTTP API and Web UI. CLI users can already do `gauntlet run x.md --passes 3`; Phase B brings the same capability — plus first-class cancel — to web users.

**Architecture:** `POST /api/run/:id` grows a `passes` body field and routes through the existing `runRunSet` orchestrator when `passes > 1`. A new `src/api/routes/run-sets.ts` owns the run-set HTTP surface (GET manifest, GET summary, DELETE = cancel) and a parallel `DELETE /api/runs/:runId` cancels solo runs. `ActiveRunRegistry` gains a `status` field so pre-registered queued attempts are visible. A new `RunSetBroadcaster` mirrors `RunBroadcaster` but is keyed by `runSetId` and emits set-level events (`pass_start`, `pass_end`, `set_done`, `set_cancelled`). On the UI, `NewRunModal` gains a `passes` input, a new `/run-sets/:id` page renders the manifest with per-attempt links and a cancel button, and `RunsList` adds a small badge linking constituent runs back to their set.

**Tech Stack:** TypeScript / Bun, Hono (API), Bun WebSocket, React + React Router on the UI, `bun:test` for tests.

**Spec:** `docs/superpowers/specs/2026-04-29-multi-pass-runs-design.md`. **Phase A (CLI) plan:** `docs/superpowers/plans/2026-04-30-multi-pass-runs-cli.md` — Phase A shipped the orchestrator (`src/runs/run-set.ts`), writer (`src/evidence/run-set-writer.ts`), CLI surface, and the `runSetCtx` seam through both `runOne` and `executeRun`. Phase B is purely additive on top of that foundation. All commits below land on `matt/pri-1440-multi-pass-runs` (or a new branch — Matt's call).

---

## File map

```
NEW
  src/api/routes/run-sets.ts             GET manifest, GET summary, DELETE run-set
  src/api/run-set-broadcaster.ts         Set-level WS pub/sub
  src/api/run-cancel.ts                  Per-run cancel registry + DELETE /api/runs/:runId
  src/api/run-set-orchestrator.ts        HTTP-side wrapper that drives runRunSet with executeRun
  test/api/run-sets.test.ts              GET manifest/summary + DELETE
  test/api/run-multi-pass.test.ts        POST /api/run/:id with passes > 1
  test/api/run-cancel.test.ts            DELETE /api/runs/:runId
  ui/src/components/RunSetDetail.tsx     New page at /run-sets/:id
  ui/src/components/RunSetDetail.test.tsx  (only if your UI test setup supports it; skip if not)

MODIFY
  src/api/routes/run.ts                  Add passes body field; route through orchestrator when passes > 1
  src/api/active-runs.ts                 Add status field; queued/running transitions
  src/api/server.ts                      Mount /api/run-sets routes; pass new dependencies
  src/index.ts                           Wire new broadcasters/registries; ws upgrade for /api/ws/run-sets/:id
  src/api/ws-handlers.ts                 New handler for set-level WS opens
  ui/src/lib/api.ts                      Add runSets namespace; extend run.start return type; add cancel endpoints
  ui/src/components/NewRunModal.tsx      Add passes numeric input
  ui/src/components/RunsList.tsx         Show badge on multi-pass-set rows
  ui/src/components/RunDetail.tsx        Show "Part of run set ..." link if result.runSet present
  ui/src/App.tsx                         New route /run-sets/:id; navigate after multi-pass start
  test/api/run.test.ts                   Update existing tests for new response shape
```

---

## Phase B.1 — Backend (API + WebSocket)

### Task 1: Extend `ActiveRunRegistry` with `status` field

**Files:**
- Modify: `src/api/active-runs.ts` (current `ActiveRunInfo` at lines 1–15, `register` at 28, `list` at 65)
- Test: `test/api/active-runs.test.ts` (extend existing or create)

Pre-registered queued attempts need a way to be distinguishable from running ones. The orchestrator wiring in Task 5 will pre-register all N attempts at `status: "queued"`, then transition each to `"running"` as it actually starts.

- [ ] **Step 1: Extend the type**

```ts
// src/api/active-runs.ts — at the top of the file
export interface ActiveRunInfo {
  id: string;
  cardId: string;
  title: string;
  target: string;
  model: string;
  startedAt: number;
  status: "queued" | "running";   // NEW
  // Optional: link back to the run set, if any
  runSetId?: string;              // NEW
  attemptNumber?: number;         // NEW (1-indexed when in a set)
  passes?: number;                // NEW (total passes in the set)
}
```

- [ ] **Step 2: Add a `setStatus` method**

```ts
// In ActiveRunRegistry class, after register/unregister:
setStatus(runId: string, status: "queued" | "running"): void {
  const snap = this.snapshots.get(runId);
  if (snap) snap.info.status = status;
}
```

- [ ] **Step 3: Update existing `register` callers to include `status`**

Search for `register({` in `src/`:

```bash
grep -rn "registry.register({" src/
```

You'll find at least:
- `src/api/routes/run.ts` around line 126 — the existing solo-run registration. Set `status: "running"` there (it's the existing behavior).

For each call site, add `status: "running"` to the object literal. The new `runSetId`/`attemptNumber`/`passes` fields are optional — only set them in Task 5 when the orchestrator pre-registers.

- [ ] **Step 4: Add a focused test**

```ts
// test/api/active-runs.test.ts (extend)
import { describe, test, expect } from "bun:test";
import { ActiveRunRegistry } from "../../src/api/active-runs";

describe("ActiveRunRegistry — status", () => {
  test("registered runs default to status='running' for callers that set it", () => {
    const r = new ActiveRunRegistry();
    r.register({
      id: "card-a_t_x", cardId: "card-a", title: "X", target: "stub",
      model: "m", startedAt: 1, status: "running",
    });
    expect(r.list()[0].status).toBe("running");
  });

  test("setStatus transitions queued → running", () => {
    const r = new ActiveRunRegistry();
    r.register({
      id: "r1", cardId: "card-a", title: "X", target: "stub",
      model: "m", startedAt: 1, status: "queued",
    });
    expect(r.list()[0].status).toBe("queued");
    r.setStatus("r1", "running");
    expect(r.list()[0].status).toBe("running");
  });
});
```

- [ ] **Step 5: Run tests + typecheck**

```bash
bun test test/api/active-runs.test.ts
bun run tsc --noEmit
```

Expected: PASS, typecheck clean.

- [ ] **Step 6: Run the full API suite**

```bash
bun test test/api/
```

Expected: PASS — existing tests adapted to the new required field.

- [ ] **Step 7: Commit**

```bash
git add src/api/active-runs.ts test/api/active-runs.test.ts test/api/run.test.ts test/api/active-runs-route.test.ts
git commit -m "feat(api): ActiveRunRegistry gains status field for queued attempts (PRI-1440)"
```

---

### Task 2: `RunSetBroadcaster` — set-level WebSocket pub/sub

**Files:**
- Create: `src/api/run-set-broadcaster.ts`
- Test: `test/api/run-set-broadcaster.test.ts`

Mirrors `RunBroadcaster` (`src/api/ws.ts:6–33`) but keyed by `runSetId`. Independent channel — clients subscribe to one or both.

- [ ] **Step 1: Write tests first**

```ts
// test/api/run-set-broadcaster.test.ts
import { describe, test, expect } from "bun:test";
import { RunSetBroadcaster } from "../../src/api/run-set-broadcaster";

class FakeWs {
  readyState = 1;
  sent: string[] = [];
  send(msg: string) { this.sent.push(msg); }
}

describe("RunSetBroadcaster", () => {
  test("send dispatches to all clients subscribed to that runSetId", () => {
    const b = new RunSetBroadcaster();
    const ws1 = new FakeWs();
    const ws2 = new FakeWs();
    const ws3 = new FakeWs();
    b.addClient("set-A", ws1 as any);
    b.addClient("set-A", ws2 as any);
    b.addClient("set-B", ws3 as any);
    b.send("set-A", { kind: "pass_start", attemptNumber: 1 });
    expect(ws1.sent).toHaveLength(1);
    expect(ws2.sent).toHaveLength(1);
    expect(ws3.sent).toHaveLength(0);
    expect(JSON.parse(ws1.sent[0])).toEqual({ kind: "pass_start", attemptNumber: 1 });
  });

  test("removeClient stops further dispatch to that ws", () => {
    const b = new RunSetBroadcaster();
    const ws = new FakeWs();
    b.addClient("set-A", ws as any);
    b.removeClient("set-A", ws as any);
    b.send("set-A", { kind: "set_done" });
    expect(ws.sent).toHaveLength(0);
  });

  test("send skips ws with readyState !== 1", () => {
    const b = new RunSetBroadcaster();
    const ws = new FakeWs();
    ws.readyState = 3;
    b.addClient("set-A", ws as any);
    b.send("set-A", { kind: "set_done" });
    expect(ws.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run; expect fail (module not found)**

```bash
bun test test/api/run-set-broadcaster.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/api/run-set-broadcaster.ts
interface WsLike {
  readyState: number;
  send(data: string): void;
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
}
```

- [ ] **Step 4: Run tests; expect pass**

```bash
bun test test/api/run-set-broadcaster.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/api/run-set-broadcaster.ts test/api/run-set-broadcaster.test.ts
git commit -m "feat(api): RunSetBroadcaster for set-level WebSocket events (PRI-1440)"
```

---

### Task 3: New routes — `GET /api/run-sets/:id`, `GET /api/run-sets/:id/summary`

**Files:**
- Create: `src/api/routes/run-sets.ts`
- Test: `test/api/run-sets.test.ts`

Reads from `<.gauntlet>/run-sets/<runSetId>/set.json` written by `RunSetWriter` (Phase A).

- [ ] **Step 1: Write the test first**

```ts
// test/api/run-sets.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runSetRoutes } from "../../src/api/routes/run-sets";

let projectRoot: string;
let runSetsDir: string;

const fakeManifest = (id: string) => ({
  schemaVersion: 1,
  runSetId: id,
  kind: "single",
  createdAt: "2026-04-30T00:00:00Z",
  completedAt: "2026-04-30T00:01:00Z",
  passes: 3,
  cards: ["card-a"],
  runs: [
    { runId: "card-a_t1_x", cardId: "card-a", attemptNumber: 1, status: "pass" },
    { runId: "card-a_t2_y", cardId: "card-a", attemptNumber: 2, status: "pass" },
    { runId: "card-a_t3_z", cardId: "card-a", attemptNumber: 3, status: "pass" },
  ],
  summary: {
    perCard: [{
      cardId: "card-a", passes: 3,
      byStatus: { pass: 3, fail: 0, investigate: 0, errored: 0, cancelled: 0 },
      cardStatus: "consistent_pass", medianTurns: 5, medianDurationMs: 4000,
    }],
    overall: {
      totalRuns: 3,
      byStatus: { pass: 3, fail: 0, investigate: 0, errored: 0, cancelled: 0 },
      overallStatus: "consistent_pass",
    },
  },
});

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-runsets-api-"));
  runSetsDir = join(projectRoot, ".gauntlet", "run-sets");
  mkdirSync(runSetsDir, { recursive: true });
});

describe("GET /api/run-sets/:id", () => {
  test("returns the manifest for an existing run set", async () => {
    const id = "single_20260430T000000Z_abcd";
    mkdirSync(join(runSetsDir, id));
    writeFileSync(join(runSetsDir, id, "set.json"), JSON.stringify(fakeManifest(id)));

    const app = new Hono();
    app.route("/api/run-sets", runSetRoutes(join(projectRoot, ".gauntlet")));

    const res = await app.request(`/api/run-sets/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runSetId).toBe(id);
    expect(body.runs).toHaveLength(3);
    expect(body.summary.overall.overallStatus).toBe("consistent_pass");
  });

  test("returns 404 for unknown run set", async () => {
    const app = new Hono();
    app.route("/api/run-sets", runSetRoutes(join(projectRoot, ".gauntlet")));
    const res = await app.request("/api/run-sets/nonexistent");
    expect(res.status).toBe(404);
  });

  test("rejects path-traversal attempts", async () => {
    const app = new Hono();
    app.route("/api/run-sets", runSetRoutes(join(projectRoot, ".gauntlet")));
    const res = await app.request("/api/run-sets/..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/run-sets/:id/summary", () => {
  test("returns just the summary block", async () => {
    const id = "single_20260430T000000Z_abcd";
    mkdirSync(join(runSetsDir, id));
    writeFileSync(join(runSetsDir, id, "set.json"), JSON.stringify(fakeManifest(id)));

    const app = new Hono();
    app.route("/api/run-sets", runSetRoutes(join(projectRoot, ".gauntlet")));

    const res = await app.request(`/api/run-sets/${id}/summary`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall.overallStatus).toBe("consistent_pass");
    expect(body.perCard).toHaveLength(1);
  });

  test("returns 404 if summary block is null (in-flight set)", async () => {
    const id = "single_20260430T000000Z_inflight";
    mkdirSync(join(runSetsDir, id));
    const m = fakeManifest(id);
    (m as any).summary = null;
    writeFileSync(join(runSetsDir, id, "set.json"), JSON.stringify(m));

    const app = new Hono();
    app.route("/api/run-sets", runSetRoutes(join(projectRoot, ".gauntlet")));
    const res = await app.request(`/api/run-sets/${id}/summary`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run; expect fail**

```bash
bun test test/api/run-sets.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/api/routes/run-sets.ts
import { Hono } from "hono";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const RUN_SET_ID_RE = /^[a-z]+_\d{8}T\d{6}Z_[a-z0-9]+$/;

export function runSetRoutes(gauntletRoot: string) {
  const router = new Hono();

  router.get("/:id", (c) => {
    const id = c.req.param("id");
    if (!RUN_SET_ID_RE.test(id)) return c.json({ error: "invalid run set id" }, 400);
    const path = join(gauntletRoot, "run-sets", id, "set.json");
    if (!existsSync(path)) return c.json({ error: "not found" }, 404);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    return c.json(manifest);
  });

  router.get("/:id/summary", (c) => {
    const id = c.req.param("id");
    if (!RUN_SET_ID_RE.test(id)) return c.json({ error: "invalid run set id" }, 400);
    const path = join(gauntletRoot, "run-sets", id, "set.json");
    if (!existsSync(path)) return c.json({ error: "not found" }, 404);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (!manifest.summary) return c.json({ error: "summary not yet computed" }, 404);
    return c.json(manifest.summary);
  });

  return router;
}
```

- [ ] **Step 4: Run; expect pass**

```bash
bun test test/api/run-sets.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/run-sets.ts test/api/run-sets.test.ts
git commit -m "feat(api): GET /api/run-sets/:id and :id/summary endpoints (PRI-1440)"
```

---

### Task 4: Per-run cancel registry + `DELETE /api/runs/:runId`

**Files:**
- Create: `src/api/run-cancel.ts`
- Test: `test/api/run-cancel.test.ts`

The orchestrator listens on a `cancelToken: { cancelled: boolean }`. For solo runs (not part of a set), the same shape is used to abort the in-flight `runAgent` loop. We need a side-channel registry that maps `runId → cancelToken` so a `DELETE` request can flip the right token.

- [ ] **Step 1: Write tests first**

```ts
// test/api/run-cancel.test.ts
import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { CancelTokenRegistry, runCancelRoutes } from "../../src/api/run-cancel";

describe("CancelTokenRegistry", () => {
  test("register/get round trip", () => {
    const r = new CancelTokenRegistry();
    const token = { cancelled: false };
    r.register("r1", token);
    expect(r.get("r1")).toBe(token);
  });

  test("unregister removes the token", () => {
    const r = new CancelTokenRegistry();
    r.register("r1", { cancelled: false });
    r.unregister("r1");
    expect(r.get("r1")).toBeUndefined();
  });
});

describe("DELETE /api/runs/:runId", () => {
  test("flips the registered cancel token; returns 202", async () => {
    const reg = new CancelTokenRegistry();
    const token = { cancelled: false };
    reg.register("r1", token);

    const app = new Hono();
    app.route("/api/runs", runCancelRoutes(reg));

    const res = await app.request("/api/runs/r1", { method: "DELETE" });
    expect(res.status).toBe(202);
    expect(token.cancelled).toBe(true);
  });

  test("returns 404 if no token registered", async () => {
    const app = new Hono();
    app.route("/api/runs", runCancelRoutes(new CancelTokenRegistry()));
    const res = await app.request("/api/runs/unknown", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/api/run-cancel.ts
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
```

- [ ] **Step 3: Run tests**

```bash
bun test test/api/run-cancel.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/api/run-cancel.ts test/api/run-cancel.test.ts
git commit -m "feat(api): CancelTokenRegistry + DELETE /api/runs/:runId (PRI-1440)"
```

---

### Task 5: Extend `POST /api/run/:id` — accept `passes`, route through orchestrator

**Files:**
- Modify: `src/api/routes/run.ts` (handler at lines 62–166; current 202 response at line 165)
- Test: `test/api/run-multi-pass.test.ts`
- Test (modified): `test/api/run.test.ts` (existing tests update to the new uniform response shape)

This is the largest backend task. The handler currently returns `{ runId, cardId }`. After this task it always returns the new shape:

```ts
{
  runSetId: string | null,   // null when passes === 1 (solo run, no RunSet)
  kind: "single",
  passes: number,
  runs: Array<{ runId: string; attemptNumber: number; status: "queued" | "running" }>
}
```

For `passes === 1`: behavior is unchanged (single `executeRun` detached, no orchestrator); response has one element in `runs` and `runSetId: null`.

For `passes > 1`: the handler builds a `RunSetConfig`, generates all N runIds eagerly (via `onAllRunsKnown`), pre-registers them in `ActiveRunRegistry` with `status: "queued"`, then detaches the orchestrator. Each pass's `executeRun` is invoked from within the orchestrator's `executor`.

- [ ] **Step 1: Update `runRoutes` signature to accept the new dependencies**

The current signature is `runRoutes(config, broadcaster?, errorLog?, registry?)`. Add two more optional params:

```ts
// src/api/routes/run.ts (around line 30 — the existing function signature)
export function runRoutes(
  config: AppConfig,
  broadcaster?: RunBroadcaster,
  errorLog?: ErrorLog,
  registry?: ActiveRunRegistry,
  setBroadcaster?: RunSetBroadcaster,    // NEW
  cancelTokens?: CancelTokenRegistry,    // NEW
) { ... }
```

These are optional — when `serve` is run, the dependencies are wired up; in tests they may be omitted, in which case multi-pass support degrades gracefully (orchestrator runs without WS broadcasting; cancel registration is a no-op).

- [ ] **Step 2: Add body validation for `passes`**

In `validateRunBody` (look for it in the same file; if not in this file, find the helper):

```ts
// Add to the validation logic:
if (body.passes !== undefined) {
  if (!Number.isInteger(body.passes) || body.passes < 1 || body.passes > 50) {
    throw new Error("passes must be an integer in [1, 50]");
  }
}
```

- [ ] **Step 3: Branch on `passes` in the handler**

After existing validation and `mergeRunConfig`, around the point where `makeRunId` is called today (line 92):

```ts
const passes = body.passes ?? 1;

if (passes === 1) {
  // Existing solo path (unchanged behavior, but new response shape)
  const runId = makeRunId(entry.card.id);
  const outDir = ensureRunOutDir(/* ... */);
  await snapshotRunInputs(/* ... */);
  if (registry) {
    registry.register({
      id: runId, cardId: entry.card.id, title: entry.card.title,
      target: body.target, model: cfg.model ?? "", startedAt: Date.now(),
      status: "running",
    });
  }
  // Optional: register cancel token for solo runs too
  const cancelToken = { cancelled: false };
  if (cancelTokens) cancelTokens.register(runId, cancelToken);
  // Detach existing executeRun call (existing logic), now passing cancelToken via runSetCtx-equivalent
  // For solo runs, executeRun doesn't take a cancelToken today — Phase A only added it for the orchestrator path.
  // For solo cancel, the simplest extension is to pass cancelToken into executeRun too. See Task 5b below.

  // Return the new uniform shape:
  return c.json({
    runSetId: null,
    kind: "single",
    passes: 1,
    runs: [{ runId, attemptNumber: 1, status: "running" }],
  }, 202);
}

// Multi-pass path — orchestrator owns the id, surfaces it via the await
const { runRunSet } = await import("../../runs/run-set");
const cancelToken = { cancelled: false };

const handle = await runRunSet({
  resultsRoot: gauntletPath(config.projectRoot),
  cards: [entry.card.id],
  passes,
  kind: "single",
  cancelToken,
  executor: async ({ runSetCtx, runId }) => {
    if (registry) registry.setStatus(runId, "running");
    if (setBroadcaster) {
      setBroadcaster.send(runSetCtx.runSetId, {
        kind: "pass_start", runId, attemptNumber: runSetCtx.attemptNumber, passes,
      });
    }
    const result = await runSingleAttempt({
      card: entry.card, cfg, body, registry, broadcaster, errorLog,
      runId, runSetCtx,
    });
    if (registry) registry.unregister(runId);
    if (setBroadcaster) {
      setBroadcaster.send(runSetCtx.runSetId, {
        kind: "pass_end", runId, attemptNumber: runSetCtx.attemptNumber,
        finalStatus: result.status,
      });
    }
    return { runId, outDir: "...", result };
  },
});

// Pre-register all attempts as queued (we now have handle.runs).
if (registry) {
  for (const r of handle.runs) {
    registry.register({
      id: r.runId, cardId: entry.card.id, title: entry.card.title,
      target: body.target, model: cfg.model ?? "", startedAt: Date.now(),
      status: "queued", attemptNumber: r.attemptNumber, passes,
      runSetId: handle.runSetId,
    });
  }
}

// Register the set-level cancel token for DELETE /api/run-sets/:id
if (cancelTokens) cancelTokens.register(handle.runSetId, cancelToken);

// Detach the long-running completion
handle.completion
  .then((setResult) => {
    if (setBroadcaster) {
      setBroadcaster.send(handle.runSetId, { kind: "set_done", summary: setResult.summary });
    }
  })
  .catch((e) => {
    errorLog?.record({ scope: "run-set", error: e });
  })
  .finally(() => {
    if (cancelTokens) cancelTokens.unregister(handle.runSetId);
    if (registry) for (const r of handle.runs) registry.unregister(r.runId);
  });

return c.json({
  runSetId: handle.runSetId,
  kind: handle.kind,
  passes: handle.passes,
  runs: handle.runs.map((r) => ({
    runId: r.runId,
    attemptNumber: r.attemptNumber,
    status: "queued" as const,
  })),
}, 202);
```

**The shape gap:** an HTTP `Create` handler needs the new resource's id back fast (so the 202 carries it) while the long-running work continues in the background. `runRunSet` currently returns a single Promise that resolves only after all attempts complete. **Resolution: change `runRunSet`'s return type to `Promise<{ runSetId, kind, passes, runs, completion }>` — the awaited Promise covers only the fast prep phase (id gen + stub `set.json` write); `completion` is the long Promise that resolves with the final `RunSetResult`.** The orchestrator still owns id generation; the caller never invents an id.

- [ ] **Step 3a: Change `runRunSet`'s return type to expose the id early**

```ts
// src/runs/run-set.ts

export interface RunSetHandle {
  runSetId: string;
  kind: RunSetKind;
  passes: number;
  cards: string[];
  runs: Array<{ runId: string; cardId: string; attemptNumber: number }>;
  completion: Promise<RunSetResult>;
}

export async function runRunSet(cfg: RunSetConfig): Promise<RunSetHandle> {
  // ── Prep phase (fast: id gen, eager runIds, set.json stub) ──
  const runSetId = makeRunSetId(cfg.kind);
  const gen = cfg.generateRunId ?? ((cardId, _i) => makeRunId(cardId));

  const allRuns: Array<{ runId: string; cardId: string; attemptNumber: number }> = [];
  for (let cardIndex = 0; cardIndex < cfg.cards.length; cardIndex++) {
    for (let attemptNumber = 1; attemptNumber <= cfg.passes; attemptNumber++) {
      allRuns.push({
        runId: gen(cfg.cards[cardIndex], attemptNumber),
        cardId: cfg.cards[cardIndex],
        attemptNumber,
      });
    }
  }

  const ctx0: RunSetCtx = {
    runSetId, kind: cfg.kind, passes: cfg.passes, cards: cfg.cards,
    cardIndex: 0, attemptNumber: 1,
  };
  const writer = new RunSetWriter(cfg.resultsRoot, ctx0);
  writer.start(allRuns);
  cfg.onAllRunsKnown?.(allRuns);

  // ── Run phase (slow: cards × passes loop). Started but not awaited. ──
  const completion = runLoop({ cfg, writer, ctx0, allRuns, runSetId });

  return { runSetId, kind: cfg.kind, passes: cfg.passes, cards: cfg.cards, runs: allRuns, completion };
}

async function runLoop(args: {
  cfg: RunSetConfig;
  writer: RunSetWriter;
  ctx0: RunSetCtx;
  allRuns: Array<{ runId: string; cardId: string; attemptNumber: number }>;
  runSetId: string;
}): Promise<RunSetResult> {
  // Body of the existing runRunSet from the loop onward, unchanged:
  // for (cardIndex...) for (attemptNumber...) { check cancelToken; executor; recordRunEnd }
  // mark unstarted as cancelled if cancelToken.cancelled
  // writer.finalize(...)
  // return { runSetId: args.runSetId, runs, summary }
}
```

This is a **breaking change** to `runRunSet`'s return type — Phase A's CLI callers (`src/cli/run.ts`, `src/cli/batch.ts`) currently do `await runRunSet(cfg)` expecting a `RunSetResult`. Update both call sites:

```ts
// src/cli/run.ts and src/cli/batch.ts — replace
const setResult = await runRunSet({ ... });
// with
const handle = await runRunSet({ ... });
const setResult = await handle.completion;
```

That's a 2-line change in each file. Do it as part of this task.

Update `test/runs/run-set.test.ts` accordingly. The 5 existing tests need their `await runRunSet(cfg)` calls changed to `await (await runRunSet(cfg)).completion`. Add one new test that asserts the early-return contract:

```ts
test("runRunSet resolves with the id and runs before the loop completes", async () => {
  let executorCalled = false;
  const handle = await runRunSet({
    resultsRoot: mkdtempSync(join(tmpdir(), "gauntlet-handle-")),
    cards: ["card-a"],
    passes: 2,
    kind: "single",
    executor: async () => {
      executorCalled = true;
      return { runId: "x", outDir: "x", result: fakeResult("pass") };
    },
    generateRunId: (cardId, i) => `${cardId}_t${i}_x000`,
  });

  // The handle is returned BEFORE the executor runs (the loop is started but not awaited).
  expect(handle.runSetId).toMatch(/^single_/);
  expect(handle.runs).toHaveLength(2);
  // set.json stub must exist on disk before the loop runs.
  expect(existsSync(join(/* resolve from cfg.resultsRoot */, "run-sets", handle.runSetId, "set.json"))).toBe(true);

  // Now wait for the loop to actually finish.
  const result = await handle.completion;
  expect(executorCalled).toBe(true);
  expect(result.summary?.overall.overallStatus).toBe("consistent_pass");
});
```

- [ ] **Step 4: Extract a `runSingleAttempt` helper**

The solo and multi-pass paths share most of the executeRun setup (adapter creation, screencast, observer wiring). Extract that into a helper that accepts `{ runId, runSetCtx?, ...sharedDeps }` and returns the `VetResult`. The solo path calls it without `runSetCtx`; the multi-pass executor calls it with `runSetCtx`.

The exact extraction depends on the current code shape — read `executeRun` (lines 215–323) and pull out the body into a `runSingleAttempt` async function. Both branches in the handler then call this helper.

- [ ] **Step 5: Write integration test for the multi-pass path**

```ts
// test/api/run-multi-pass.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "fs";
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

    // All three should be pre-registered as queued.
    const active = registry.list();
    expect(active.length).toBeGreaterThanOrEqual(1); // at least one is running by now
  });

  test("solo run (passes omitted) returns the new shape with runSetId: null", async () => {
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
```

- [ ] **Step 6: Update existing tests in `test/api/run.test.ts`**

The existing tests assert the old `{ runId, cardId }` response shape. Change the assertions to:

```ts
expect(body.runs[0].runId).toMatch(/^api-multi-pass-test_\d{8}T\d{6}Z_[a-z0-9]{4}$/);
expect(body.runSetId).toBeNull();    // solo
expect(body.passes).toBe(1);
```

- [ ] **Step 7: Run all API tests**

```bash
bun test test/api/
bun run tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/api/routes/run.ts src/runs/run-set.ts test/api/run.test.ts test/api/run-multi-pass.test.ts test/runs/run-set.test.ts
git commit -m "feat(api): POST /api/run/:id accepts passes; routes through orchestrator (PRI-1440)"
```

---

### Task 6: `DELETE /api/run-sets/:id` — cancel an in-flight set

**Files:**
- Modify: `src/api/routes/run-sets.ts` (extend the file from Task 3)
- Modify: `src/api/routes/run.ts` (register set-level cancel token alongside per-run tokens)
- Test: extend `test/api/run-sets.test.ts`

The handler in Task 5 created a `cancelToken` for the orchestrator. This task exposes a way to flip it via HTTP, parallel to `DELETE /api/runs/:runId` from Task 4.

The simplest design: a parallel `SetCancelTokenRegistry` (or extend `CancelTokenRegistry` to handle both run and set IDs — since their formats are non-overlapping, a single registry works). For minimum change, **add a second registry**.

- [ ] **Step 1: Confirm Task 5's set-token registration**

Tokens for solo runs and tokens for run sets live in the same registry — runIds and runSetIds have non-overlapping formats (`<cardId>_…` vs `<kind>_…`). No new class needed. Task 5's multi-pass branch already calls `cancelTokens.register(handle.runSetId, cancelToken)` and unregisters in the finally; this task just exposes the DELETE endpoint.

- [ ] **Step 3: Add the DELETE route**

Extend `src/api/routes/run-sets.ts`:

```ts
import type { CancelTokenRegistry } from "../run-cancel";

export function runSetRoutes(gauntletRoot: string, cancelTokens?: CancelTokenRegistry) {
  const router = new Hono();
  // ...existing GET routes...

  router.delete("/:id", (c) => {
    const id = c.req.param("id");
    if (!RUN_SET_ID_RE.test(id)) return c.json({ error: "invalid run set id" }, 400);
    const token = cancelTokens?.get(id);
    if (!token) return c.json({ error: "not in flight" }, 404);
    token.cancelled = true;
    return c.json({ status: "cancelling" }, 202);
  });

  return router;
}
```

- [ ] **Step 4: Update `server.ts` to pass `cancelTokens` into `runSetRoutes`**

```ts
// src/api/server.ts — line 36 area
if (runSetsEnabled) {
  api.route("/run-sets", runSetRoutes(gauntletPath(config.projectRoot), cancelTokens));
}
```

The `cancelTokens` instance is constructed in `src/index.ts` (the `serve` command) alongside `broadcaster` and `registry`. Add it there and pass through `createApp`.

- [ ] **Step 5: Test**

```ts
// extend test/api/run-sets.test.ts
test("DELETE /api/run-sets/:id flips cancel token and returns 202", async () => {
  const cancelTokens = new CancelTokenRegistry();
  const token = { cancelled: false };
  cancelTokens.register("single_20260430T000000Z_abcd", token);

  const app = new Hono();
  app.route("/api/run-sets", runSetRoutes(join(projectRoot, ".gauntlet"), cancelTokens));

  const res = await app.request(`/api/run-sets/single_20260430T000000Z_abcd`, { method: "DELETE" });
  expect(res.status).toBe(202);
  expect(token.cancelled).toBe(true);
});

test("DELETE returns 404 if no in-flight set with that id", async () => {
  const app = new Hono();
  app.route("/api/run-sets", runSetRoutes(join(projectRoot, ".gauntlet"), new CancelTokenRegistry()));
  const res = await app.request(`/api/run-sets/single_20260430T000000Z_xyz`, { method: "DELETE" });
  expect(res.status).toBe(404);
});
```

- [ ] **Step 6: Run tests**

```bash
bun test test/api/run-sets.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/api/routes/run-sets.ts src/api/routes/run.ts src/api/server.ts src/index.ts test/api/run-sets.test.ts
git commit -m "feat(api): DELETE /api/run-sets/:id cancels in-flight run set (PRI-1440)"
```

---

### Task 7: WebSocket upgrade for `/api/ws/run-sets/:id`

**Files:**
- Modify: `src/index.ts` (Bun.serve config at lines 137–161)
- Modify: `src/api/ws-handlers.ts` (add `handleSetWsOpen`)

The CLI side of cancel and progress already broadcasts to `RunSetBroadcaster` from inside the orchestrator's executor (Task 5). This task adds the WS upgrade path so the UI can subscribe to `ws://.../api/ws/run-sets/<runSetId>`.

- [ ] **Step 1: Add a new handler in `ws-handlers.ts`**

```ts
// src/api/ws-handlers.ts
export function handleSetWsOpen(
  setBroadcaster: RunSetBroadcaster,
  runSetId: string,
  ws: WsLike,
  gauntletRoot: string,
): void {
  setBroadcaster.addClient(runSetId, ws);

  // Send initial snapshot if the set already has a manifest on disk.
  const path = join(gauntletRoot, "run-sets", runSetId, "set.json");
  if (existsSync(path)) {
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      ws.send(JSON.stringify({ kind: "snapshot", manifest }));
    } catch { /* ignore */ }
  }
}
```

- [ ] **Step 2: Update `Bun.serve` to upgrade `/api/ws/run-sets/:id` requests**

In `src/index.ts` around the existing `/api/ws` upgrade (line 142):

```ts
if (url.pathname.startsWith("/api/ws/run-sets/")) {
  const runSetId = url.pathname.slice("/api/ws/run-sets/".length);
  if (!/^[a-z]+_\d{8}T\d{6}Z_[a-z0-9]+$/.test(runSetId)) {
    return new Response("invalid run set id", { status: 400 });
  }
  const upgraded = server.upgrade(req, { data: { runSetId } });
  if (upgraded) return undefined;
  return new Response("WebSocket upgrade failed", { status: 400 });
}

if (url.pathname === "/api/ws") {
  // existing handling
}
```

In the `websocket: { open(ws) { ... } }` block, branch:

```ts
open(ws) {
  const data = ws.data as any;
  if (data.runSetId) {
    handleSetWsOpen(setBroadcaster, data.runSetId, ws as any, gauntletRoot);
  } else if (data.runId) {
    handleWsOpen(registry, broadcaster, data.runId, ws as any, resultsRoot);
  }
},
close(ws) {
  const data = ws.data as any;
  if (data.runSetId) {
    setBroadcaster.removeClient(data.runSetId, ws as any);
  } else if (data.runId) {
    broadcaster.removeClient(data.runId, ws as any);
  }
},
```

- [ ] **Step 3: Smoke test (manual)**

There isn't a great way to test WS upgrades inside `bun:test` without spinning up a server. The `RunSetBroadcaster` itself is unit-tested (Task 2). The integration test in Task 14 (final sanity) covers the end-to-end flow.

- [ ] **Step 4: Run tests + typecheck**

```bash
bun test
bun run tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/api/ws-handlers.ts
git commit -m "feat(api): WebSocket upgrade for /api/ws/run-sets/:id (PRI-1440)"
```

---

## Phase B.2 — Frontend (UI)

### Task 8: API client — `runSets` namespace and extended `run.start` return type

**Files:**
- Modify: `ui/src/lib/api.ts` (existing `run.start` at lines 188–193, request helper at 82–95)

- [ ] **Step 1: Add types**

```ts
// ui/src/lib/api.ts — add near the existing types
export interface RunSetSummary {
  perCard: Array<{
    cardId: string;
    passes: number;
    byStatus: { pass: number; fail: number; investigate: number; errored: number; cancelled: number };
    cardStatus: string;
    medianTurns: number;
    medianDurationMs: number;
  }>;
  overall: {
    totalRuns: number;
    byStatus: { pass: number; fail: number; investigate: number; errored: number; cancelled: number };
    overallStatus: string;
  };
}

export interface RunSetManifest {
  schemaVersion: 1;
  runSetId: string;
  kind: "single" | "batch";
  createdAt: string;
  completedAt: string | null;
  passes: number;
  cards: string[];
  runs: Array<{ runId: string; cardId: string; attemptNumber: number; status: string }>;
  summary: RunSetSummary | null;
}

export interface StartRunResponse {
  runSetId: string | null;
  kind: "single" | "batch";
  passes: number;
  runs: Array<{ runId: string; attemptNumber: number; status: "queued" | "running" }>;
}
```

- [ ] **Step 2: Update `run.start` return type**

```ts
// ui/src/lib/api.ts — replace the existing run.start
run: {
  start: (cardId: string, body: {
    target: string;
    model?: string;
    adapter?: string;
    chrome?: string;
    turns?: number;
    viewport?: { width: number; height: number };
    saveScreencast?: boolean;
    passes?: number;   // NEW
  }) =>
    request<StartRunResponse>(`/run/${cardId}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  cancel: (runId: string) =>
    request<{ status: "cancelling" }>(`/runs/${encodeURIComponent(runId)}`, { method: "DELETE" }),
},
```

- [ ] **Step 3: Add `runSets` namespace**

```ts
runSets: {
  get: (runSetId: string) =>
    request<RunSetManifest>(`/run-sets/${encodeURIComponent(runSetId)}`),
  summary: (runSetId: string) =>
    request<RunSetSummary>(`/run-sets/${encodeURIComponent(runSetId)}/summary`),
  cancel: (runSetId: string) =>
    request<{ status: "cancelling" }>(`/run-sets/${encodeURIComponent(runSetId)}`, { method: "DELETE" }),
},
```

- [ ] **Step 4: Update existing call sites in App.tsx**

The current callsite (around App.tsx:329) reads `runId` from the response. Update:

```ts
const result = await api.run.start(cardId, config);
if (result.runSetId) {
  navigate(`/run-sets/${result.runSetId}`);
} else {
  navigate(`/runs/live/${result.runs[0].runId}`);
}
```

- [ ] **Step 5: Typecheck the UI**

```bash
cd ui && bun run tsc --noEmit
# or whatever the existing UI typecheck command is — check ui/package.json
```

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/api.ts ui/src/App.tsx
git commit -m "feat(ui): api client gains runSets namespace and StartRunResponse shape (PRI-1440)"
```

---

### Task 9: `NewRunModal` — `passes` numeric input

**Files:**
- Modify: `ui/src/components/NewRunModal.tsx` (form state at 33–52, Turns field example at 199–210, submit handler at 78–110)

- [ ] **Step 1: Add state**

```ts
// In NewRunModal component, alongside the existing useState calls (after line 52):
const [passes, setPasses] = useState<string>(prefill?.passes !== undefined ? String(prefill.passes) : "");
```

- [ ] **Step 2: Add the form field**

After the Turns field (line ~210), add:

```tsx
<div>
  <label className="section-label block mb-1">Passes</label>
  <input
    className="input-field"
    type="number"
    min={1}
    max={50}
    value={passes}
    onChange={(e) => setPasses(e.target.value)}
    placeholder="1"
  />
  <p className="text-xs text-slate mt-1">
    Run the same story N times and aggregate. Default: 1.
  </p>
</div>
```

- [ ] **Step 3: Update submit handler**

In `handleStart` (lines 78–110), after the `turns` parsing block, add:

```ts
let passesNum: number | undefined;
if (passes.trim() !== "") {
  const parsed = Number.parseInt(passes, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 50) {
    setError("Passes must be an integer in [1, 50]");
    return;
  }
  passesNum = parsed;
}
```

Then include it in the `onStarted` config object:

```ts
onStarted(selectedCard, {
  target: target.trim(),
  // ...existing fields...
  passes: passesNum,
});
```

- [ ] **Step 4: Update the prefill type**

Find `NewRunPrefill` (likely in `App.tsx` or `NewRunModal.tsx`). Add `passes?: number`.

- [ ] **Step 5: Typecheck**

```bash
cd ui && bun run tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/NewRunModal.tsx ui/src/App.tsx
git commit -m "feat(ui): NewRunModal gains passes input (PRI-1440)"
```

---

### Task 10: `/run-sets/:id` page — new component

**Files:**
- Create: `ui/src/components/RunSetDetail.tsx`
- Modify: `ui/src/App.tsx` (route registration at 288–319)

This is the largest UI task. The page needs to:
1. Fetch the manifest via `api.runSets.get(id)` on mount.
2. Subscribe to `ws://.../api/ws/run-sets/:id` for live updates.
3. Render a header with overall status and per-card rollups.
4. Render each attempt as a row with its `runId`, `attemptNumber`, status, and a link to `/runs/:runId` (post-hoc) or `/runs/live/:runId` (live).
5. Show a Cancel button while the set is in-flight (`completedAt === null`); on click, call `api.runSets.cancel(id)`.

- [ ] **Step 1: Implement**

```tsx
// ui/src/components/RunSetDetail.tsx
import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, type RunSetManifest } from "../lib/api";

export function RunSetDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [manifest, setManifest] = useState<RunSetManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Initial fetch
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.runSets
      .get(id)
      .then((m) => { if (!cancelled) setManifest(m); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [id]);

  // WS subscription
  useEffect(() => {
    if (!id) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws/run-sets/${encodeURIComponent(id)}`);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.kind === "snapshot" && msg.manifest) {
          setManifest(msg.manifest);
        } else if (msg.kind === "pass_end" || msg.kind === "set_done" || msg.kind === "set_cancelled") {
          // Re-fetch the manifest to pick up the new state
          api.runSets.get(id).then(setManifest).catch(() => {});
        }
      } catch { /* ignore */ }
    };
    return () => { ws.close(); };
  }, [id]);

  const handleCancel = async () => {
    if (!id) return;
    setCancelling(true);
    try {
      await api.runSets.cancel(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancel failed");
    }
  };

  if (error) return <div className="p-6 text-red">Error: {error}</div>;
  if (!manifest) return <div className="p-6 text-slate">Loading…</div>;

  const inFlight = manifest.completedAt === null;

  return (
    <div className="p-6 max-w-4xl">
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-bold text-ink">
          Run set · {manifest.kind} · {manifest.passes} {manifest.passes === 1 ? "attempt" : "attempts"}
        </h1>
        {inFlight && (
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="btn-secondary"
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>

      <div className="mb-4 text-sm text-slate">
        <div>Cards: {manifest.cards.join(", ")}</div>
        <div>Created: {manifest.createdAt}</div>
        {manifest.completedAt && <div>Completed: {manifest.completedAt}</div>}
      </div>

      {manifest.summary && (
        <div className="mb-6 p-3 bg-slate-50 rounded">
          <div className="font-semibold text-ink mb-2">
            Overall: {manifest.summary.overall.overallStatus}
          </div>
          <div className="text-sm text-slate">
            {Object.entries(manifest.summary.overall.byStatus)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => `${n} ${k}`)
              .join(" · ")}
          </div>
          {manifest.summary.perCard.map((c) => (
            <div key={c.cardId} className="mt-3 text-sm">
              <span className="font-medium text-ink">{c.cardId}</span>
              <span className="text-slate"> — {c.cardStatus} · median {c.medianTurns} turns / {Math.round(c.medianDurationMs)}ms</span>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1">
        {manifest.runs.map((r) => {
          const live = r.status === "running" || r.status === "queued";
          const linkTo = live ? `/runs/live/${r.runId}` : `/runs/${r.runId}`;
          return (
            <Link
              key={r.runId}
              to={linkTo}
              className="block p-3 border border-slate-200 rounded hover:bg-slate-50"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm text-ink">
                  Attempt {r.attemptNumber} of {manifest.passes} · {r.cardId}
                </span>
                <span className="text-xs text-slate">{r.status}</span>
              </div>
              <div className="text-xs text-slate mt-1 font-mono">{r.runId}</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Register the route in `App.tsx`**

In the `<Routes>` block (around line 288):

```tsx
<Route path="/run-sets/:id" element={<RunSetDetail />} />
```

Add the import at the top:

```ts
import { RunSetDetail } from "./components/RunSetDetail";
```

- [ ] **Step 3: Typecheck**

```bash
cd ui && bun run tsc --noEmit
```

- [ ] **Step 4: Manual smoke test**

Start the server and navigate to `http://localhost:3000/run-sets/<id>` for a known run set. Verify:
- Manifest loads, shows summary, per-card rollups, attempt rows.
- Cancel button is present iff `completedAt === null`.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/RunSetDetail.tsx ui/src/App.tsx
git commit -m "feat(ui): /run-sets/:id page (PRI-1440)"
```

---

### Task 11: `RunsList` badge + `RunDetail` link for runs in a run set

**Files:**
- Modify: `ui/src/components/RunsList.tsx` (row rendering at 190–216)
- Modify: `ui/src/components/RunDetail.tsx`
- Modify: `ui/src/lib/api.ts` (`VetResult` type — add `runSet?` field)

The per-run `result.json` stamp (Phase A Task 3) lets the UI see which runs belong to a set without an extra API call. Add:
- A small badge on `RunsList` rows when `result.runSet` is present, linking to `/run-sets/:runSetId`.
- A "Part of run set …" link on `RunDetail`.

- [ ] **Step 1: Extend the `VetResult` type**

```ts
// ui/src/lib/api.ts — extend VetResult
export interface VetResult {
  // ...existing fields...
  runSet?: {
    runSetId: string;
    kind: "single" | "batch";
    passes: number;
    cards: string[];
    cardIndex: number;
    attemptNumber: number;
  };
}
```

- [ ] **Step 2: Add badge in `RunsList`**

In the completed-row rendering (around line 197):

```tsx
{result.runSet && (
  <Link
    to={`/run-sets/${result.runSet.runSetId}`}
    onClick={(e) => e.stopPropagation()}
    className="text-xs text-teal underline"
  >
    set · {result.runSet.attemptNumber}/{result.runSet.passes}
  </Link>
)}
```

Place the badge near the `StatusBadge` in the row's right side. Match the existing layout patterns.

- [ ] **Step 3: Add link in `RunDetail`**

Near the top of the result detail layout, add:

```tsx
{result.runSet && (
  <div className="mb-3 text-sm">
    Part of run set{" "}
    <Link to={`/run-sets/${result.runSet.runSetId}`} className="text-teal underline">
      {result.runSet.runSetId}
    </Link>
    {" — attempt "}{result.runSet.attemptNumber} of {result.runSet.passes}
  </div>
)}
```

- [ ] **Step 4: Typecheck**

```bash
cd ui && bun run tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/RunsList.tsx ui/src/components/RunDetail.tsx ui/src/lib/api.ts
git commit -m "feat(ui): badge + link from runs to their run set (PRI-1440)"
```

---

### Task 12: "Run Again" preserves `passes`

**Files:**
- Modify: `ui/src/components/RunDetail.tsx` (Run Again handler at lines 168–176)

The existing Run Again button rebuilds a `NewRunPrefill` from `result.config`. Extend it to read `passes` from `result.runSet?.passes` if present.

- [ ] **Step 1: Update the prefill construction**

```tsx
// ui/src/components/RunDetail.tsx — replace existing onRunAgain call
onClick={() => onRunAgain({
  cardId: result.scenario,
  target: result.config!.target,
  model: result.config!.model,
  chrome: result.config!.chrome,
  turns: result.config!.turns,
  adapter: result.config!.adapter,
  viewport: result.config!.viewport,
  saveScreencast: result.config!.saveScreencast,
  passes: result.runSet?.passes,   // NEW
})}
```

- [ ] **Step 2: Verify the field flows through `NewRunPrefill` to the modal**

`NewRunPrefill` should already have `passes?: number` from Task 9. Confirm by typechecking.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/RunDetail.tsx
git commit -m "feat(ui): Run Again preserves passes count (PRI-1440)"
```

---

## Phase B.3 — Sanity

### Task 13: Final integration sweep + In Review

- [ ] **Step 1: Run the full test suite**

```bash
bun test
bun run tsc --noEmit
cd ui && bun run tsc --noEmit
```

Expected: PASS, typecheck clean (both Bun and UI).

- [ ] **Step 2: Hand-verify the API**

Start the server in one terminal:

```bash
bun run src/index.ts serve --port 3001
```

In another terminal:

```bash
# Multi-pass run via curl
curl -sS -X POST http://localhost:3001/api/run/<your-card-id> \
  -H "Content-Type: application/json" \
  -d '{"target":"http://localhost:3000","passes":3}' | jq
```

Verify the response has `runSetId` (non-null) and 3 entries in `runs[]`.

```bash
# Fetch the manifest mid-run
curl -sS http://localhost:3001/api/run-sets/<runSetId> | jq

# Cancel
curl -sS -X DELETE http://localhost:3001/api/run-sets/<runSetId>
```

- [ ] **Step 3: Hand-verify the UI**

Navigate to `http://localhost:3001/cards`, click "New Run", fill in the form with `Passes: 3`, submit. Verify:
- Browser navigates to `/run-sets/<id>`.
- Page shows three attempt rows.
- Cancel button is visible while the set is in-flight.
- Each attempt's row links to `/runs/live/<runId>` while running, `/runs/<runId>` once complete.
- Returning to the runs list, the runs from the set show the "set · N/M" badge.

- [ ] **Step 4: Smoke-test the cancel flow**

While a multi-pass run is in flight, click Cancel. Verify:
- The current attempt finishes (or aborts).
- Remaining attempts are marked `cancelled` in `set.json`.
- The page updates to show the cancelled state via the WS `set_cancelled` event.

- [ ] **Step 5: Move PRI-1440 to In Review (already there from Phase A)**

Phase A already moved the ticket to In Review. Phase B continues on the same ticket. Add a comment summarizing what shipped:

Use the linear-ticket-lifecycle skill's reflective-comment template. Cover:
- What went smoothly (the Phase A foundation made the API extension natural)
- What was tricky (the chicken-and-egg `runSetId` generation in the response shape; the `executeRun` extraction)
- How you felt
- Risk flags (WS reconnect on browser tab refresh? Verify the snapshot path catches up)

- [ ] **Step 6: Final commit if any tweaks landed**

```bash
git status
git log --oneline matt/pri-1440-multi-pass-runs..HEAD  # commits since the start of phase B
```

---

## Out of scope / follow-on

- **Concurrent passes (`--concurrency K`)** — deferred per spec Q6.
- **`/api/run-sets?cardId=...` listing endpoint** — useful but not strictly required for v1.
- **WS reconnect logic on the UI** — if the browser drops the WS, we re-fetch on page focus. A more robust reconnect-with-resume is a follow-on.
- **"Re-run just the failed attempts"** — out of scope per spec Q5.
- **Comprehensive UI overhaul** that integrates transcripts, live runs, and run sets into a unified view — Matt's note from Q2: that's a separate, broader effort.
