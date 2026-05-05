# Shared Run Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Bobiverse note:** Pick your own Bob name. Commit co-author line should be `Co-Authored-By: <YourName> (Bob <session-id-prefix>/<model>) <noreply@anthropic.com>` — fill in per the Bobiverse protocol from your session start hook.

**Linear ticket:** PRI-1481 (already In Dev).

**Source spec:** `docs/superpowers/specs/2026-05-04-shared-run-orchestrator-design.md`. Read it first; this plan implements that contract.

**Goal:** Extract a single product-independent run-core orchestrator (`src/runs/orchestrator.ts`) so CLI's `runOne` and HTTP's `executeRun` stop duplicating snapshot, logger, adapter, context tree, agent, and result-writing logic.

**Architecture:** New `executeRunCore` owns the single-attempt lifecycle (steps 1–19 in the spec). CLI's `runOne` and HTTP's renamed `executeHttpRun` become thin shims that build a client, translate config, and pass surface-specific behavior in via narrow hooks (`onLogger`, `beforeAgent`, `onError`, `beforeClose`, `afterClose`). `runRunSet` stays as the multi-attempt group orchestrator. Three intentional behavior changes for HTTP — see spec §"Intentional behavior changes."

**Tech Stack:** TypeScript, Bun (runtime + test runner), Hono (HTTP). Tests: `bun:test`. Existing helpers in `test/e2e/helpers` (`makeScriptedClient`, `report`).

---

## Task 0: Branch setup

**Files:** none (git operations only).

- [ ] **Step 1: Create the feature branch matching the Linear `gitBranchName`**

```bash
git checkout -b matt/pri-1481-refactor-unify-cli-runone-and-http-executerun-into-one
```

- [ ] **Step 2: Confirm working tree is clean of unrelated edits**

```bash
git status
```

Expected: untracked files (`docs/scratch/`, `spikes/`, `y`, `docs/context-*.md`, etc. from session start) and the modified `examples/tutorial/.gauntlet/stories/04-login-credentials.md` are unrelated to this work and should be left alone. The two new docs we created (`docs/superpowers/specs/2026-05-04-shared-run-orchestrator-design.md` and `docs/superpowers/plans/2026-05-05-shared-run-orchestrator.md`) belong on this branch and will be committed in Task 1.

---

## Task 1: Skeleton — types and stub `executeRunCore`

**Files:**
- Create: `src/runs/orchestrator.ts`
- Create: `test/runs/orchestrator.test.ts`

- [ ] **Step 1: Write the orchestrator skeleton**

```ts
// src/runs/orchestrator.ts
import type { Adapter } from "../adapters/adapter";
import type { ChromeEndpoint, Viewport } from "../config";
import type { EvidenceLogger } from "../evidence/logger";
import type { LLMClient } from "../models/provider";
import type { StoryCard } from "../format/story-card";
import type { VetResult } from "../types";
import type { RunSetCtx } from "./run-set-types";

export type RunAdapterType = "web" | "cli" | "tui";

export interface RunCoreConfig {
  projectRoot: string;
  model: string;
  adapter: RunAdapterType;
  target: string;
  turns: number;
  /** Already-resolved Chrome endpoint, or undefined to let WebAdapter
   * auto-launch. Surfaces collapse "default" → undefined themselves. */
  chrome?: ChromeEndpoint;
  viewport?: Viewport;
}

export interface RunCorePrepared {
  runId: string;
  outDir: string;
  card: StoryCard;
}

export interface RunCoreStarted extends RunCorePrepared {
  contextRoot: string;
  /** The started adapter. Hooks may read state (e.g., a WebAdapter's
   * chrome session for screencast wiring) but must not start, close, or
   * otherwise mutate the lifecycle — that is the core's job. */
  adapter: Adapter;
}

export interface RunCoreHooks {
  /** Attach observers to the freshly-built logger. Optional detach fn is
   * called after adapter close so close-time events still fan out. */
  onLogger?: (logger: EvidenceLogger, ctx: RunCorePrepared) => void | (() => void);
  beforeAgent?: (ctx: RunCoreStarted) => Promise<void> | void;
  onError?: (err: unknown, ctx: RunCoreStarted | RunCorePrepared) => Promise<void> | void;
  beforeClose?: (ctx: RunCoreStarted) => Promise<void> | void;
  afterClose?: (ctx: RunCoreStarted | RunCorePrepared) => Promise<void> | void;
}

export interface AdapterFactoryCtx {
  contextRoot: string;
  runId: string;
  logger: EvidenceLogger;
}

export interface ExecuteRunCoreOptions {
  card: StoryCard;
  storyPath: string;
  runId?: string;
  outDir?: string;
  runConfig: RunCoreConfig;
  /** Already-built client — surfaces resolve provider/allow-list before
   * calling the core so config errors stay on the request thread. */
  client: LLMClient;
  runSetCtx?: RunSetCtx;
  hooks?: RunCoreHooks;
  /** Test seam: substitute the adapter construction. Production callers
   * leave this undefined and the core builds the adapter from
   * `runConfig.adapter`. Tests inject stub adapters here instead of
   * `mock.module`-ing adapter modules globally. Mirrors the
   * `clientFactory?` pattern from PRI-1505. */
  adapterFactory?: (ctx: AdapterFactoryCtx) => Adapter | Promise<Adapter>;
}

export interface ExecuteRunCoreResult {
  runId: string;
  outDir: string;
  result: VetResult;
}

export async function executeRunCore(
  _opts: ExecuteRunCoreOptions,
): Promise<ExecuteRunCoreResult> {
  throw new Error("executeRunCore not implemented");
}
```

- [ ] **Step 2: Write the test-file skeleton**

```ts
// test/runs/orchestrator.test.ts
import { describe, test, expect } from "bun:test";
import { executeRunCore } from "../../src/runs/orchestrator";

describe("executeRunCore — skeleton", () => {
  test("module exports executeRunCore", () => {
    expect(typeof executeRunCore).toBe("function");
  });
});
```

**No `mock.module` in this file.** Per PRI-1505: Bun's `mock.module` is process-global and `mock.restore()` does not undo it, so any module mock here would pollute every test that runs after. All tests use DI seams (the `client` parameter on `executeRunCore`, plus targeted helpers) instead.

- [ ] **Step 3: Run the skeleton test**

Run: `bun test test/runs/orchestrator.test.ts`
Expected: 1 pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-05-04-shared-run-orchestrator-design.md \
        docs/superpowers/plans/2026-05-05-shared-run-orchestrator.md \
        src/runs/orchestrator.ts \
        test/runs/orchestrator.test.ts
git commit -m "PRI-1481: scaffold shared run orchestrator types and stub"
```

---

## Task 2: Happy-path TDD — snapshot, run, write result

**Files:**
- Modify: `src/runs/orchestrator.ts`
- Modify: `test/runs/orchestrator.test.ts`

- [ ] **Step 1: Write the failing happy-path test**

Append to `test/runs/orchestrator.test.ts`:

```ts
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseStoryCard } from "../../src/format/story-card";
import { report, makeScriptedClient } from "../e2e/helpers";

const HAPPY_CARD = `---
id: orch-happy
title: orchestrator happy path
status: ready
---

A minimal card.
`;

describe("executeRunCore — happy path", () => {
  test("snapshots inputs, runs the agent, writes result.json and run.jsonl", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-happy-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);

    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    const { runId, outDir, result } = await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        turns: 5,
      },
    });

    expect(runId).toMatch(/^orch-happy_/);
    expect(outDir).toContain(runId);
    expect(result.status).toBe("pass");
    expect(existsSync(join(outDir, "result.json"))).toBe(true);
    expect(existsSync(join(outDir, "run.jsonl"))).toBe(true);
    expect(existsSync(join(outDir, "inputs", "card.md"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/runs/orchestrator.test.ts`
Expected: FAIL with "executeRunCore not implemented".

- [ ] **Step 3: Implement the happy-path lifecycle**

Replace the entire body of `src/runs/orchestrator.ts` with:

```ts
import { join } from "path";
import { CLIAdapter } from "../adapters/cli/adapter";
import { snapshotViewport, type Adapter } from "../adapters/adapter";
import type { ChromeEndpoint, Viewport } from "../config";
import { renderContextTree } from "../context/tree";
import { EvidenceLogger } from "../evidence/logger";
import { writeResultFiles } from "../evidence/writer";
import { runAgent } from "../agent/agent";
import { resolveProvider } from "../models/resolve";
import type { LLMClient } from "../models/provider";
import { gauntletPath } from "../paths";
import { snapshotRunInputs } from "./snapshot";
import { makeRunId } from "../util/id";
import type { StoryCard } from "../format/story-card";
import type { RunConfigSnapshot, VetResult } from "../types";
import type { RunSetCtx } from "./run-set-types";

export type RunAdapterType = "web" | "cli" | "tui";

export interface RunCoreConfig {
  projectRoot: string;
  model: string;
  adapter: RunAdapterType;
  target: string;
  turns: number;
  chrome?: ChromeEndpoint;
  viewport?: Viewport;
}

export interface RunCorePrepared {
  runId: string;
  outDir: string;
  card: StoryCard;
}

export interface RunCoreStarted extends RunCorePrepared {
  contextRoot: string;
  adapter: Adapter;
}

export interface RunCoreHooks {
  onLogger?: (logger: EvidenceLogger, ctx: RunCorePrepared) => void | (() => void);
  beforeAgent?: (ctx: RunCoreStarted) => Promise<void> | void;
  onError?: (err: unknown, ctx: RunCoreStarted | RunCorePrepared) => Promise<void> | void;
  beforeClose?: (ctx: RunCoreStarted) => Promise<void> | void;
  afterClose?: (ctx: RunCoreStarted | RunCorePrepared) => Promise<void> | void;
}

export interface AdapterFactoryCtx {
  contextRoot: string;
  runId: string;
  logger: EvidenceLogger;
}

export interface ExecuteRunCoreOptions {
  card: StoryCard;
  storyPath: string;
  runId?: string;
  outDir?: string;
  runConfig: RunCoreConfig;
  client: LLMClient;
  runSetCtx?: RunSetCtx;
  hooks?: RunCoreHooks;
  /** Test seam — see Task 1 type definition for full rationale. */
  adapterFactory?: (ctx: AdapterFactoryCtx) => Adapter | Promise<Adapter>;
}

export interface ExecuteRunCoreResult {
  runId: string;
  outDir: string;
  result: VetResult;
}

function viewportString(v: Viewport | undefined): string | undefined {
  return v ? `${v.width}x${v.height}` : undefined;
}

async function buildDefaultAdapter(
  type: RunAdapterType,
  contextRoot: string,
  logger: EvidenceLogger,
  runId: string,
  chrome: ChromeEndpoint | undefined,
  viewport: Viewport | undefined,
): Promise<Adapter> {
  switch (type) {
    case "cli":
      return new CLIAdapter({ contextRoot });
    case "tui": {
      const { TUIAdapter } = await import("../adapters/tui/adapter");
      return new TUIAdapter({ contextRoot });
    }
    case "web": {
      const { WebAdapter } = await import("../adapters/web/adapter");
      return new WebAdapter({
        chrome,
        contextRoot,
        logger,
        chromeProfileName: `gauntlet-run-${runId}`,
        viewport,
      });
    }
  }
}

export async function executeRunCore(
  opts: ExecuteRunCoreOptions,
): Promise<ExecuteRunCoreResult> {
  const { card, storyPath, runConfig, client, runSetCtx } = opts;

  const runId = opts.runId ?? makeRunId(card.id);
  const outDir = opts.outDir ?? gauntletPath(runConfig.projectRoot, "results", runId);

  snapshotRunInputs({
    runDir: outDir,
    storyPath,
    contextRoot: gauntletPath(runConfig.projectRoot, "context"),
  });

  const logger = new EvidenceLogger(outDir);
  const contextRoot = join(outDir, "inputs", "context");
  const contextTree = renderContextTree(contextRoot);

  const adapter = await (opts.adapterFactory
    ? opts.adapterFactory({ contextRoot, runId, logger })
    : buildDefaultAdapter(
        runConfig.adapter,
        contextRoot,
        logger,
        runId,
        runConfig.chrome,
        runConfig.viewport,
      ));

  await adapter.start(runConfig.target);

  const stampedRunConfig: RunConfigSnapshot = {
    target: runConfig.target,
    model: runConfig.model,
    adapter: runConfig.adapter,
    chrome: runConfig.chrome ? `${runConfig.chrome.host}:${runConfig.chrome.port}` : undefined,
    turns: runConfig.turns,
    viewport: snapshotViewport(adapter),
  };

  try {
    const result = await runAgent(card, adapter, client, logger, runConfig.target, {
      contextTree,
      runId,
      maxTurns: runConfig.turns,
      provider: resolveProvider(runConfig.model),
      model: runConfig.model,
      outDir,
      viewport: runConfig.adapter === "web"
        ? viewportString(snapshotViewport(adapter))
        : undefined,
    });
    result.config = stampedRunConfig;
    if (runSetCtx) result.runSet = runSetCtx;
    writeResultFiles(outDir, result);
    return { runId, outDir, result };
  } finally {
    await adapter.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/runs/orchestrator.test.ts`
Expected: 2 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/runs/orchestrator.ts test/runs/orchestrator.test.ts
git commit -m "PRI-1481: implement executeRunCore happy-path lifecycle"
```

---

## Task 3: TDD — runConfig and runSet stamping

**Files:**
- Modify: `test/runs/orchestrator.test.ts`

(Implementation already covers stamping — this task locks the behavior with explicit tests.)

- [ ] **Step 1: Write the failing stamping tests**

Append to `test/runs/orchestrator.test.ts`:

```ts
import type { RunSetCtx } from "../../src/runs/run-set-types";

describe("executeRunCore — result metadata", () => {
  test("stamps result.config with the run config snapshot", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-cfg-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    const { outDir } = await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        turns: 7,
      },
    });

    const resultJson = JSON.parse(readFileSync(join(outDir, "result.json"), "utf-8"));
    expect(resultJson.config).toMatchObject({
      target: "true",
      model: "claude-sonnet-4-6",
      adapter: "cli",
      turns: 7,
    });
  });

  test("stamps result.runSet when runSetCtx is provided", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-rsctx-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    const ctx: RunSetCtx = {
      runSetId: "rset-orch-001",
      kind: "single",
      passes: 2,
      cards: ["orch-happy"],
      cardIndex: 0,
      attemptNumber: 1,
    };

    const { outDir } = await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        turns: 5,
      },
      runSetCtx: ctx,
    });

    const resultJson = JSON.parse(readFileSync(join(outDir, "result.json"), "utf-8"));
    expect(resultJson.runSet).toEqual(ctx);
  });

  test("omits result.runSet when runSetCtx is not provided", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-norsctx-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    const { outDir } = await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        turns: 5,
      },
    });

    const resultJson = JSON.parse(readFileSync(join(outDir, "result.json"), "utf-8"));
    expect(resultJson.runSet).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test test/runs/orchestrator.test.ts`
Expected: 5 pass, 0 fail (the 2-pass baseline + 3 new).

- [ ] **Step 3: Commit**

```bash
git add test/runs/orchestrator.test.ts
git commit -m "PRI-1481: lock runConfig and runSetCtx stamping in core"
```

---

## Task 4: TDD — onLogger hook with detach-after-close

**Files:**
- Modify: `src/runs/orchestrator.ts`
- Modify: `test/runs/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/runs/orchestrator.test.ts`:

```ts
describe("executeRunCore — onLogger hook", () => {
  test("invokes onLogger before runAgent and detaches after adapter close", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-onlog-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    const calls: string[] = [];
    let attached = false;

    await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        turns: 5,
      },
      hooks: {
        onLogger: (logger) => {
          attached = true;
          calls.push("attach");
          return () => {
            attached = false;
            calls.push("detach");
          };
        },
      },
    });

    expect(attached).toBe(false);
    expect(calls).toEqual(["attach", "detach"]);
  });

  test("onLogger return value undefined is allowed (no detach)", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-onlog2-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    let attached = false;
    await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        turns: 5,
      },
      hooks: {
        onLogger: () => {
          attached = true;
        },
      },
    });
    expect(attached).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test test/runs/orchestrator.test.ts`
Expected: FAIL — `onLogger` is currently ignored by the implementation.

- [ ] **Step 3: Wire `onLogger` into the lifecycle**

In `src/runs/orchestrator.ts`, replace the body of `executeRunCore` with this updated version (the diff is: add `hooks` destructure, capture `prepared` ctx, call `onLogger` after logger creation, run detach in `finally` after `adapter.close()`):

```ts
export async function executeRunCore(
  opts: ExecuteRunCoreOptions,
): Promise<ExecuteRunCoreResult> {
  const { card, storyPath, runConfig, client, runSetCtx, hooks } = opts;

  const runId = opts.runId ?? makeRunId(card.id);
  const outDir = opts.outDir ?? gauntletPath(runConfig.projectRoot, "results", runId);

  snapshotRunInputs({
    runDir: outDir,
    storyPath,
    contextRoot: gauntletPath(runConfig.projectRoot, "context"),
  });

  const logger = new EvidenceLogger(outDir);
  const prepared: RunCorePrepared = { runId, outDir, card };
  const detachLogger = hooks?.onLogger?.(logger, prepared) ?? (() => {});

  const contextRoot = join(outDir, "inputs", "context");
  const contextTree = renderContextTree(contextRoot);

  const adapter = await (opts.adapterFactory
    ? opts.adapterFactory({ contextRoot, runId, logger })
    : buildDefaultAdapter(
        runConfig.adapter,
        contextRoot,
        logger,
        runId,
        runConfig.chrome,
        runConfig.viewport,
      ));

  try {
    await adapter.start(runConfig.target);

    const stampedRunConfig: RunConfigSnapshot = {
      target: runConfig.target,
      model: runConfig.model,
      adapter: runConfig.adapter,
      chrome: runConfig.chrome ? `${runConfig.chrome.host}:${runConfig.chrome.port}` : undefined,
      turns: runConfig.turns,
      viewport: snapshotViewport(adapter),
    };

    const result = await runAgent(card, adapter, client, logger, runConfig.target, {
      contextTree,
      runId,
      maxTurns: runConfig.turns,
      provider: resolveProvider(runConfig.model),
      model: runConfig.model,
      outDir,
      viewport: runConfig.adapter === "web"
        ? viewportString(snapshotViewport(adapter))
        : undefined,
    });
    result.config = stampedRunConfig;
    if (runSetCtx) result.runSet = runSetCtx;
    writeResultFiles(outDir, result);
    return { runId, outDir, result };
  } finally {
    try { await adapter.close(); } catch { /* swallow during cleanup */ }
    detachLogger();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/runs/orchestrator.test.ts`
Expected: 7 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/runs/orchestrator.ts test/runs/orchestrator.test.ts
git commit -m "PRI-1481: wire onLogger hook with detach-after-close ordering"
```

---

## Task 5: TDD — beforeAgent / beforeClose / afterClose hooks

**Files:**
- Modify: `src/runs/orchestrator.ts`
- Modify: `test/runs/orchestrator.test.ts`

- [ ] **Step 1: Write the failing call-order test**

Append to `test/runs/orchestrator.test.ts`:

```ts
describe("executeRunCore — lifecycle hooks", () => {
  test("calls hooks in spec order: onLogger.attach → beforeAgent → beforeClose → adapter.close → onLogger.detach → afterClose", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-hooks-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    const calls: string[] = [];

    await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        turns: 5,
      },
      hooks: {
        onLogger: () => {
          calls.push("onLogger.attach");
          return () => calls.push("onLogger.detach");
        },
        beforeAgent: () => { calls.push("beforeAgent"); },
        beforeClose: () => { calls.push("beforeClose"); },
        afterClose: () => { calls.push("afterClose"); },
      },
    });

    expect(calls).toEqual([
      "onLogger.attach",
      "beforeAgent",
      "beforeClose",
      "onLogger.detach",
      "afterClose",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test test/runs/orchestrator.test.ts`
Expected: FAIL — hooks not yet wired.

- [ ] **Step 3: Wire the remaining hooks**

In `src/runs/orchestrator.ts`, modify the `try`/`finally` body to call `beforeAgent`, `beforeClose`, and `afterClose`:

```ts
  try {
    await adapter.start(runConfig.target);

    const started: RunCoreStarted = { ...prepared, contextRoot, adapter };
    await hooks?.beforeAgent?.(started);

    const stampedRunConfig: RunConfigSnapshot = {
      target: runConfig.target,
      model: runConfig.model,
      adapter: runConfig.adapter,
      chrome: runConfig.chrome ? `${runConfig.chrome.host}:${runConfig.chrome.port}` : undefined,
      turns: runConfig.turns,
      viewport: snapshotViewport(adapter),
    };

    const result = await runAgent(card, adapter, client, logger, runConfig.target, {
      contextTree,
      runId,
      maxTurns: runConfig.turns,
      provider: resolveProvider(runConfig.model),
      model: runConfig.model,
      outDir,
      viewport: runConfig.adapter === "web"
        ? viewportString(snapshotViewport(adapter))
        : undefined,
    });
    result.config = stampedRunConfig;
    if (runSetCtx) result.runSet = runSetCtx;
    writeResultFiles(outDir, result);

    await hooks?.beforeClose?.(started);
    try { await adapter.close(); } catch { /* swallow */ }
    detachLogger();
    await hooks?.afterClose?.(started);

    return { runId, outDir, result };
  } catch (err) {
    // beforeClose runs even on error so streamer-stop hooks fire
    try { await hooks?.beforeClose?.({ ...prepared, contextRoot }); } catch { /* swallow */ }
    try { await adapter.close(); } catch { /* swallow */ }
    detachLogger();
    try { await hooks?.afterClose?.({ ...prepared, contextRoot }); } catch { /* swallow */ }
    throw err;
  }
```

Also remove the now-redundant `finally` block — cleanup is performed on both the success and error branches. The whole function becomes:

```ts
export async function executeRunCore(
  opts: ExecuteRunCoreOptions,
): Promise<ExecuteRunCoreResult> {
  const { card, storyPath, runConfig, client, runSetCtx, hooks } = opts;

  const runId = opts.runId ?? makeRunId(card.id);
  const outDir = opts.outDir ?? gauntletPath(runConfig.projectRoot, "results", runId);

  snapshotRunInputs({
    runDir: outDir,
    storyPath,
    contextRoot: gauntletPath(runConfig.projectRoot, "context"),
  });

  const logger = new EvidenceLogger(outDir);
  const prepared: RunCorePrepared = { runId, outDir, card };
  const detachLogger = hooks?.onLogger?.(logger, prepared) ?? (() => {});

  const contextRoot = join(outDir, "inputs", "context");
  const contextTree = renderContextTree(contextRoot);

  const adapter = await (opts.adapterFactory
    ? opts.adapterFactory({ contextRoot, runId, logger })
    : buildDefaultAdapter(
        runConfig.adapter,
        contextRoot,
        logger,
        runId,
        runConfig.chrome,
        runConfig.viewport,
      ));

  try {
    await adapter.start(runConfig.target);
    const started: RunCoreStarted = { ...prepared, contextRoot, adapter };
    await hooks?.beforeAgent?.(started);

    const stampedRunConfig: RunConfigSnapshot = {
      target: runConfig.target,
      model: runConfig.model,
      adapter: runConfig.adapter,
      chrome: runConfig.chrome ? `${runConfig.chrome.host}:${runConfig.chrome.port}` : undefined,
      turns: runConfig.turns,
      viewport: snapshotViewport(adapter),
    };

    const result = await runAgent(card, adapter, client, logger, runConfig.target, {
      contextTree,
      runId,
      maxTurns: runConfig.turns,
      provider: resolveProvider(runConfig.model),
      model: runConfig.model,
      outDir,
      viewport: runConfig.adapter === "web"
        ? viewportString(snapshotViewport(adapter))
        : undefined,
    });
    result.config = stampedRunConfig;
    if (runSetCtx) result.runSet = runSetCtx;
    writeResultFiles(outDir, result);

    await hooks?.beforeClose?.(started);
    try { await adapter.close(); } catch { /* swallow */ }
    detachLogger();
    await hooks?.afterClose?.(started);

    return { runId, outDir, result };
  } catch (err) {
    const ctx: RunCoreStarted = { ...prepared, contextRoot, adapter };
    try { await hooks?.beforeClose?.(ctx); } catch { /* swallow */ }
    try { await adapter.close(); } catch { /* swallow */ }
    detachLogger();
    try { await hooks?.afterClose?.(ctx); } catch { /* swallow */ }
    throw err;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/runs/orchestrator.test.ts`
Expected: 8 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/runs/orchestrator.ts test/runs/orchestrator.test.ts
git commit -m "PRI-1481: wire beforeAgent/beforeClose/afterClose hooks"
```

---

## Task 6: TDD — error path (run_error event + onError hook + rethrow)

**Files:**
- Modify: `src/runs/orchestrator.ts`
- Modify: `test/runs/orchestrator.test.ts`

- [ ] **Step 1: Write the failing error-path test**

Append to `test/runs/orchestrator.test.ts`:

```ts
describe("executeRunCore — error path", () => {
  test("logs run_error to run.jsonl, calls onError, runs cleanup, then rethrows", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-err-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);

    // DI seam: a scripted client with zero scripts throws
    // "No more scripted responses" on the first chat() call. This
    // exercises the error path without mocking any module.
    const client = makeScriptedClient([]);

    const calls: string[] = [];

    await expect(
      executeRunCore({
        card,
        storyPath,
        client,
        runConfig: {
          projectRoot,
          model: "claude-sonnet-4-6",
          adapter: "cli",
          target: "true",
          turns: 5,
        },
        hooks: {
          onLogger: () => { calls.push("attach"); return () => calls.push("detach"); },
          onError: () => { calls.push("onError"); },
          beforeClose: () => { calls.push("beforeClose"); },
          afterClose: () => { calls.push("afterClose"); },
        },
      }),
    ).rejects.toThrow(/No more scripted responses/);

    // Full error-path lifecycle. onError fires first (while logger is
    // still attached so error annotations remain observable), then the
    // streamer-stop slot (beforeClose), then adapter.close, then the
    // detach, then afterClose. Locking the full sequence — adding a new
    // hook here is supposed to surface as a test break.
    expect(calls).toEqual([
      "attach",
      "onError",
      "beforeClose",
      "detach",
      "afterClose",
    ]);

    // Find the orch-err output dir and read run.jsonl
    const { readdirSync } = await import("fs");
    const outDirs = readdirSync(join(projectRoot, ".gauntlet", "results"));
    expect(outDirs.length).toBe(1);
    const runJsonl = readFileSync(
      join(projectRoot, ".gauntlet", "results", outDirs[0], "run.jsonl"),
      "utf-8",
    );
    const lines = runJsonl.trim().split("\n").map((l) => JSON.parse(l));
    const errorEvent = lines.find((l) => l.type === "run_error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toMatch(/No more scripted responses/);
    expect(errorEvent.turn).toBe(-1); // pre-runAgent convention from runOne
  });
});
```

Note on call order: `onError` runs BEFORE `detach`. Rationale: `onError` may emit annotations through still-attached observers. Wire the implementation to match.

- [ ] **Step 2: Run test to verify failure**

Run: `bun test test/runs/orchestrator.test.ts`
Expected: FAIL — neither `run_error` event nor `onError` hook are emitted.

- [ ] **Step 3: Implement the error path**

In `src/runs/orchestrator.ts`, replace the `catch` block of `executeRunCore` with:

```ts
  } catch (err) {
    logger.logEvent("run_error", {
      turn: -1,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    const ctx: RunCoreStarted = { ...prepared, contextRoot, adapter };
    try { await hooks?.onError?.(err, ctx); } catch { /* swallow */ }
    try { await hooks?.beforeClose?.(ctx); } catch { /* swallow */ }
    try { await adapter.close(); } catch { /* swallow */ }
    detachLogger();
    try { await hooks?.afterClose?.(ctx); } catch { /* swallow */ }
    throw err;
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test test/runs/orchestrator.test.ts`
Expected: 9 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/runs/orchestrator.ts test/runs/orchestrator.test.ts
git commit -m "PRI-1481: emit run_error and call onError on thrown errors"
```

---

## Task 7: Boundary test (negative coverage)

**Files:**
- Modify: `test/runs/orchestrator.test.ts`

- [ ] **Step 1: Write the boundary test**

Append to `test/runs/orchestrator.test.ts`:

```ts
describe("executeRunCore — boundary", () => {
  test("orchestrator source does not import HTTP-only types", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "src", "runs", "orchestrator.ts"),
      "utf-8",
    );
    expect(src).not.toContain("RunBroadcaster");
    expect(src).not.toContain("ActiveRunRegistry");
    expect(src).not.toContain("ScreencastStreamer");
    expect(src).not.toContain("RunSetBroadcaster");
    expect(src).not.toContain("ErrorLog");
    expect(src).not.toContain("from \"hono\"");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test test/runs/orchestrator.test.ts`
Expected: 10 pass, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add test/runs/orchestrator.test.ts
git commit -m "PRI-1481: add boundary test enforcing core has no HTTP-only deps"
```

---

## Task 8: Convert `runOne` to a thin shim

**Files:**
- Modify: `src/cli/run-one.ts`

- [ ] **Step 1: Replace `runOne` body with a shim that delegates to `executeRunCore`**

Critical: `RunOneOptions.clientFactory?` is the established DI test seam from PRI-1505. Existing tests pass `clientFactory: () => scriptedClient`. The shim MUST preserve this signature so those tests keep passing.

Replace the entire contents of `src/cli/run-one.ts` with:

```ts
import { readFileSync } from "fs";
import { parseStoryCard } from "../format/story-card";
import { EvidenceLogger } from "../evidence/logger";
import { createClient } from "../models/resolve";
import { executeRunCore, type RunAdapterType } from "../runs/orchestrator";
import type { AppConfig } from "../config";
import type { LLMClient } from "../models/provider";
import type { VetResult } from "../types";
import type { RunSetCtx } from "../runs/run-set-types";

export interface RunOneOptions {
  scenarioPath: string;
  target: string;
  outDir?: string;
  adapterType: RunAdapterType;
  config: AppConfig;
  /** Invoked once with the freshly constructed EvidenceLogger, before
   * runAgent starts. Returns a detach function that runs after the
   * adapter is closed. The single-card command uses this to attach the
   * streaming renderer; batch.ts uses it to subscribe its per-card
   * observer. */
  onLogger?: (logger: EvidenceLogger) => () => void;
  runSetCtx?: RunSetCtx;
  /** Externally-supplied runId (from the orchestrator). When provided,
   * this overrides the `makeRunId(card.id)` call so the run directory
   * name matches what the RunSet manifest already recorded. */
  runId?: string;
  /** Test seam: substitute the LLM client construction. Production callers
   * leave this undefined and the shim falls through to `createClient`.
   * Tests inject a scripted client here instead of `mock.module`-ing
   * `models/resolve` (PRI-1505). */
  clientFactory?: (model: string) => LLMClient;
}

export interface RunOneSummary {
  runId: string;
  outDir: string;
  result: VetResult;
}

export async function runOne(opts: RunOneOptions): Promise<RunOneSummary> {
  const { scenarioPath, target, adapterType, config } = opts;

  const content = readFileSync(scenarioPath, "utf-8");
  const card = parseStoryCard(content);

  const client = (opts.clientFactory ?? createClient)(config.models.agent);
  const chrome = config.sources.defaultChrome === "default"
    ? undefined
    : config.defaultChrome;

  return executeRunCore({
    card,
    storyPath: scenarioPath,
    runId: opts.runId,
    outDir: opts.outDir,
    client,
    runSetCtx: opts.runSetCtx,
    runConfig: {
      projectRoot: config.projectRoot,
      model: config.models.agent,
      adapter: adapterType,
      target,
      turns: config.defaultTurns,
      chrome,
      viewport: config.defaultViewport,
    },
    hooks: opts.onLogger
      ? { onLogger: (logger) => opts.onLogger!(logger) }
      : undefined,
  });
}
```

- [ ] **Step 2: Run CLI tests**

Run: `bun test test/cli/run-one.test.ts`
Expected: PASS (all existing tests).

- [ ] **Step 3: Spot-check the parse-failure test still works**

The existing test "propagates parseStoryCard errors and never calls onLogger when parse fails" is critical — verify it still passes specifically:

Run: `bun test test/cli/run-one.test.ts -t "parseStoryCard errors"`
Expected: PASS.

- [ ] **Step 4: Run all CLI-adjacent tests**

Run: `bun test test/cli/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/run-one.ts
git commit -m "PRI-1481: collapse runOne into thin shim around executeRunCore"
```

---

## Task 9: Rename `executeRun` → `executeHttpRun`, route to core via hooks

**Files:**
- Modify: `src/api/routes/run.ts`

- [ ] **Step 1: Rewrite the route file**

Replace the entire contents of `src/api/routes/run.ts` with:

```ts
import { Hono } from "hono";
import { join } from "path";
import { findCard } from "../../cards/store";
import {
  SUPPORTED_MODEL_PREFIXES_MESSAGE,
  UnknownModelProviderError,
  createClientForProvider,
  resolveProvider,
} from "../../models/resolve";
import { makeRunId } from "../../util/id";
import { gauntletPath } from "../../paths";
import { mergeRunConfig, validateRunBody, type AppConfig } from "../../config";
import { runRunSet } from "../../runs/run-set";
import {
  executeRunCore,
  type ExecuteRunCoreOptions,
  type ExecuteRunCoreResult,
  type RunCoreHooks,
} from "../../runs/orchestrator";
import type { RunBroadcaster } from "../ws";
import type { ActiveRunRegistry } from "../active-runs";
import type { RunSetBroadcaster } from "../run-set-broadcaster";
import type { CancelTokenRegistry } from "../run-cancel";
import type { ScreencastStreamer as ScreencastStreamerType } from "../../streaming/screencast";
import type { ErrorLog } from "./errors";
import type { StoryCard } from "../../format/story-card";
import type { LLMClient } from "../../models/provider";
import type { RunSetCtx } from "../../runs/run-set-types";

export interface ExecuteHttpRunOpts {
  runId: string;
  card: StoryCard;
  storyPath: string;
  client: LLMClient;
  effective: ReturnType<typeof mergeRunConfig>;
  projectRoot: string;
  broadcaster?: RunBroadcaster;
  registry?: ActiveRunRegistry;
  errorLog?: ErrorLog;
  /** Token used to guard against clobbering a freshly-registered entry
   * with the same key. Omit for multi-pass attempts so the unregister
   * always wins; pre-register-then-detach (solo) supplies it. */
  startedAt?: number;
  runSetCtx?: RunSetCtx;
  /** Test seam: forwarded to executeRunCore. Production routes leave
   * undefined; tests stub the adapter without touching modules. */
  adapterFactory?: ExecuteRunCoreOptions["adapterFactory"];
}

/**
 * HTTP wrapper around executeRunCore. Owns: progress observer, event
 * observer, screencast streamer, error log writes, registry unregister,
 * terminal broadcast (in unregister-then-broadcast order so a
 * late-connecting WS sees an empty registry).
 */
export async function executeHttpRun(
  opts: ExecuteHttpRunOpts,
): Promise<ExecuteRunCoreResult> {
  const { runId, card, storyPath, client, effective, projectRoot,
          broadcaster, registry, errorLog, startedAt, runSetCtx } = opts;

  let streamer: ScreencastStreamerType | undefined;
  let terminal: Record<string, unknown> | null = null;

  const hooks: RunCoreHooks = {
    onLogger: (logger) => {
      const detachers: Array<() => void> = [];
      if (broadcaster || registry) {
        detachers.push(logger.addObserver((action, params) => {
          const message = `[${action}] ${JSON.stringify(params)}`;
          broadcaster?.send(runId, {
            type: "progress",
            message,
            status: "running",
            card: card.id,
          });
          registry?.recordProgress(runId, message);
        }));
      }
      if (broadcaster) {
        detachers.push(logger.addEventObserver((event) => {
          broadcaster.send(runId, { type: "event", event });
        }));
      }
      return () => { for (const d of detachers) d(); };
    },
    beforeAgent: async (ctx) => {
      if (effective.adapter === "web" && (broadcaster || registry)) {
        const { ScreencastStreamer } = await import("../../streaming/screencast");
        // PRI-1436: share the WebAdapter's chrome-ws-lib session so the
        // screencast talks to the same Chrome the adapter started
        // (correct activePort, correct connection pool).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const webAdapter = ctx.adapter as any;
        const chromeSession = webAdapter.getChromeSession();
        const framesDir = effective.saveScreencast === false
          ? undefined
          : join(gauntletPath(projectRoot, "results", runId), "frames");
        streamer = new ScreencastStreamer(0, (frame) => {
          broadcaster?.send(runId, {
            type: "frame",
            data: frame.data,
            width: frame.metadata.width,
            height: frame.metadata.height,
          });
          registry?.recordFrame(runId, {
            data: frame.data,
            width: frame.metadata.width,
            height: frame.metadata.height,
          });
        }, chromeSession, framesDir);
        await streamer.start();
      }
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      errorLog?.add("run", `${runId}: ${message}`);
      terminal = { type: "error", message };
    },
    beforeClose: async () => {
      if (streamer) {
        try { await streamer.stop(); } catch { /* ignore */ }
      }
    },
    afterClose: () => {
      registry?.unregister(runId, startedAt);
      if (terminal) broadcaster?.send(runId, terminal);
    },
  };

  try {
    const result = await executeRunCore({
      card,
      storyPath,
      runId,
      client,
      runSetCtx,
      adapterFactory: opts.adapterFactory,
      runConfig: {
        projectRoot,
        model: effective.model,
        adapter: effective.adapter,
        target: effective.target,
        turns: effective.turns,
        chrome: effective.chrome,
        viewport: effective.viewport,
      },
      hooks,
    });
    terminal = { type: "complete", result: result.result };
    // afterClose has already run by this point in the success path,
    // so emit the success terminal directly.
    broadcaster?.send(runId, terminal);
    return result;
  } catch (err) {
    // onError already populated `terminal` and ErrorLog; afterClose
    // already broadcast it. Just rethrow so the multi-pass executor
    // observes the failure.
    throw err;
  }
}

export function runRoutes(
  config: AppConfig,
  broadcaster?: RunBroadcaster,
  errorLog?: ErrorLog,
  registry?: ActiveRunRegistry,
  setBroadcaster?: RunSetBroadcaster,
  cancelTokens?: CancelTokenRegistry,
  clientFactory?: (model: string) => LLMClient,
) {
  const router = new Hono();

  router.post("/:id", async (c) => {
    const entry = findCard(config.projectRoot, c.req.param("id"), errorLog);
    if (!entry) return c.json({ error: "not found" }, 404);

    const rawBody = await c.req.json().catch(() => ({}));
    let body;
    try {
      body = validateRunBody(rawBody);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    let effective;
    try {
      effective = mergeRunConfig(config, body);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    if (config.models.available.length > 0 && !config.models.available.includes(effective.model)) {
      return c.json({ error: `model "${effective.model}" is not in GAUNTLET_MODELS allow-list` }, 400);
    }

    let provider;
    try {
      provider = resolveProvider(effective.model);
    } catch (err) {
      if (err instanceof UnknownModelProviderError) {
        return c.json({
          error: "unknown_model",
          message: `Model not supported. ${SUPPORTED_MODEL_PREFIXES_MESSAGE}`,
        }, 400);
      }
      throw err;
    }

    const client = clientFactory
      ? clientFactory(effective.model)
      : createClientForProvider(effective.model, provider);

    const passes = body.passes ?? 1;
    const storyPath = join(gauntletPath(config.projectRoot, "stories"), entry.filename);

    if (passes === 1) {
      // ── Solo path ──
      const runId = makeRunId(entry.card.id);
      const startedAt = Date.now();
      if (registry) {
        registry.register({
          id: runId,
          cardId: entry.card.id,
          title: entry.card.title,
          target: effective.target,
          model: effective.model,
          startedAt,
          status: "running",
        });
      }

      executeHttpRun({
        runId,
        card: entry.card,
        storyPath,
        client,
        effective,
        projectRoot: config.projectRoot,
        broadcaster,
        registry,
        errorLog,
        startedAt,
      }).catch(() => {
        // executeHttpRun's onError hook already wrote to errorLog and
        // broadcast the terminal error event before rethrowing. Swallow
        // here to satisfy the unhandled-rejection rule without
        // double-logging.
      });

      return c.json({
        runSetId: null,
        kind: "single",
        passes: 1,
        runs: [{ runId, attemptNumber: 1, status: "running" as const }],
      }, 202);
    }

    // ── Multi-pass path ──
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

        const { result, outDir } = await executeHttpRun({
          runId,
          card: entry.card,
          storyPath,
          client,
          effective,
          projectRoot: config.projectRoot,
          broadcaster,
          registry,
          errorLog,
          // No startedAt — see solo-path comment in legacy code.
          runSetCtx,
        });

        if (setBroadcaster) {
          setBroadcaster.send(runSetCtx.runSetId, {
            kind: "pass_end", runId, attemptNumber: runSetCtx.attemptNumber,
            finalStatus: result.status,
          });
        }

        return { runId, outDir, result };
      },
    });

    if (registry) {
      for (const r of handle.runs) {
        registry.register({
          id: r.runId,
          cardId: entry.card.id,
          title: entry.card.title,
          target: effective.target,
          model: effective.model,
          startedAt: Date.now(),
          status: "queued",
          attemptNumber: r.attemptNumber,
          passes,
          runSetId: handle.runSetId,
        });
      }
    }

    if (cancelTokens) cancelTokens.register(handle.runSetId, cancelToken);

    handle.completion
      .then((setResult) => {
        if (setBroadcaster) {
          setBroadcaster.send(handle.runSetId, { kind: "set_done", summary: setResult.summary });
        }
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        errorLog?.add("run", `run-set ${handle.runSetId}: ${message}`);
      })
      .finally(() => {
        if (cancelTokens) cancelTokens.unregister(handle.runSetId);
        if (registry) {
          for (const r of handle.runs) registry.unregister(r.runId);
        }
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
  });

  return router;
}

```

The old `executeRun` symbol is removed. Direct callers in tests are migrated in Step 2 below.

- [ ] **Step 2: Migrate direct `executeRun` callers in `test/api/run.test.ts`**

Two tests call `executeRun(...)` directly with pre-built stub adapters: the unregister-before-broadcast test (around line 193) and `runExecuteWithStubbedWebAdapter` (around line 335). Both need to switch to `executeHttpRun(...)` with the new `adapterFactory` test seam.

The migration shape, applied to BOTH callsites:

```ts
// Before:
await executeRun({
  runId,
  card,
  adapter: stubAdapter,
  adapterType: "cli", // or "web"
  client: stubClient,
  target: "http://localhost:3000",
  outDir: resultsDir,
  logger,
  broadcaster,    // present in unregister test
  registry,
  saveScreencast, // present in screencast test
});

// After:
import { executeHttpRun } from "../../src/api/routes/run";
import { mergeRunConfig, validateRunBody, loadConfig } from "../../src/config";
import { writeFileSync, mkdirSync } from "fs";

// Need a real story file for snapshotRunInputs (the core writes inputs/
// from this path). The unregister test fails before runAgent so the
// content does not need to be valid; just provide *something*.
const storyDir = gauntletPath(projectRoot, "stories");
mkdirSync(storyDir, { recursive: true });
const storyPath = join(storyDir, "story-001.md");
writeFileSync(storyPath, `---\nid: story-001\ntitle: Test\nstatus: draft\ntags: core\n---\n\nbody\n\n## Acceptance Criteria\n- works\n`);

const cfg = loadConfig({ projectRoot }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
const effective = mergeRunConfig(cfg, validateRunBody({
  target: "http://localhost:3000",
  adapter: "cli",       // or "web" for the screencast test
  saveScreencast,       // pass through for screencast test only
}));

await executeHttpRun({
  runId,
  card,
  storyPath,
  client: stubClient,
  effective,
  projectRoot,
  broadcaster,
  registry,
  adapterFactory: () => stubAdapter,
});
```

Notes for the migration:
- The pre-built `logger` and `outDir` are no longer passed — the core constructs them. The tests do not reference these after the call, so dropping them is harmless.
- The unregister test's stub adapter throws on `start()` — that exercises the same error path through the new lifecycle (`onError` → `beforeClose` → `adapter.close` → detach → `afterClose` with broadcast).
- The screencast test's stub adapter exposes `getChromeSession() => ({})`; that still works because `beforeAgent` reads `ctx.adapter.getChromeSession()` from the stub.
- The screencast test's assertion (`framesDir` exists vs not) is unaffected — `ScreencastStreamer`'s constructor still does the synchronous `mkdirSync` before `start()` is awaited.

- [ ] **Step 3: Run HTTP solo tests**

Run: `bun test test/api/run.test.ts`
Expected: PASS.

If a viewport-related assertion fails: the test pinned the pre-start value. Update the assertion to the post-start value (which equals the constructor-supplied viewport per the spec — see "Intentional behavior changes" §3). Do not revert the lifecycle.

- [ ] **Step 4: Commit**

```bash
git add src/api/routes/run.ts test/api/run.test.ts
git commit -m "PRI-1481: route HTTP runs through executeRunCore via executeHttpRun"
```

---

## Task 10: Verify multi-pass path

**Files:** none (already collapsed in Task 9).

- [ ] **Step 1: Run multi-pass tests**

Run: `bun test test/api/run-multi-pass.test.ts`
Expected: PASS.

- [ ] **Step 2: Inspect that multi-pass executor body is the slim version**

Read `src/api/routes/run.ts` and confirm the multi-pass `executor` function body (inside `runRunSet({ ..., executor: async (...) => { ... } })`) contains no `snapshotRunInputs`, `new EvidenceLogger`, `createAdapter`, `renderContextTree`, or `readFileSync(join(outDir, "result.json"))`. It should call `executeHttpRun` and forward broadcasts only.

(Acceptance criterion from the spec: ≤25 lines, no inline assembly.)

- [ ] **Step 3: If everything passes, no commit needed.** If the inspection found anything missed in Task 9, fix and commit:

```bash
git add src/api/routes/run.ts
git commit -m "PRI-1481: trim multi-pass executor to thin executeHttpRun call"
```

---

## Task 11: Full test sweep

**Files:** none.

- [ ] **Step 1: Run the full suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 2: Triage any failures**

Most likely failure shapes:
- A test imports the old un-aliased `executeRun` and the alias re-export is missing → confirm `export const executeRun = executeHttpRun;` is present in the route file.
- A test mock-modules `../../src/cli/run-one` and asserts internal call shape → update the assertion to match the shim behavior.
- A viewport assertion drift (see Task 9 step 2 note).

Fix and re-run until clean.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "PRI-1481: align tests with shared orchestrator"
```

(Skip if no fixes were needed.)

---

## Task 12: Merge and Linear handoff

**Files:** none (git + Linear).

- [ ] **Step 1: Verify branch state**

Run: `git status && git log --oneline main..HEAD`
Expected: clean working tree; commits listed are all PRI-1481 work.

- [ ] **Step 2: Merge to main with `--no-ff` (per project convention)**

Per memory: this project does not use PRs. Merge feature branch into `main` directly.

```bash
git checkout main
git merge --no-ff matt/pri-1481-refactor-unify-cli-runone-and-http-executerun-into-one
git push origin main
```

- [ ] **Step 3: Move PRI-1481 to In Review**

Use the linear MCP tool (`mcp__plugin_linear_linear__save_issue`) with:
- `id: "PRI-1481"`
- `state: "In Review"`

- [ ] **Step 4: Write the reflective comment on PRI-1481**

Use `mcp__plugin_linear_linear__save_comment` with `issueId: "PRI-1481"` and a body that covers (per linear-ticket-lifecycle skill):
- What went smoothly
- What was tricky (anticipate: viewport assertion drift, or the WebAdapter chrome-session sharing in `beforeAgent` — this plan punts on that and a follow-up may be needed)
- Subjective experience and confidence level
- Risk flags (anything reviewers should watch — no specific known issues at plan time, but flag anything you discovered)

Be genuine, not performative. This is field notes, not a status report.

---

## Self-review notes (already incorporated)

- **Spec coverage:** every section of the spec lifecycle (steps 1–19) maps to a task. Hooks (`onLogger`, `beforeAgent`, `onError`, `beforeClose`, `afterClose`) all driven by tests in Tasks 4-6. Boundary test in Task 7. CLI shim in Task 8. HTTP rename + collapse in Task 9. Multi-pass collapse verified in Task 10. Acceptance criteria covered through Task 12.
- **Behavior changes** (run_error in HTTP run.jsonl, detach-after-close ordering, viewport timing) are visible in Tasks 6, 4-5, and 2 respectively, and called out in Task 9 step 2 troubleshooting.
- **PRI-1436 chrome-session sharing preserved:** `RunCoreStarted` exposes the started adapter so `beforeAgent` can read the WebAdapter's chrome session and pass it into `ScreencastStreamer`. The hook still does not start, close, or otherwise mutate the adapter — read-only access only.
