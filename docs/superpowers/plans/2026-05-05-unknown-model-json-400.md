# Unknown Model JSON 400 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /api/run/:id` return `400 application/json` for unsupported model prefixes before client construction or run registration.

**Architecture:** Keep `resolveProvider` as the single source of truth for provider-prefix rules, but make its unknown-prefix failure typed. The run route resolves the provider once after request validation, maps only `UnknownModelProviderError` to `400 unknown_model`, reuses the provider for client construction and run metadata, and lets other exceptions flow to the app-level JSON 500 backstop.

**Tech Stack:** Bun test runner, Hono routes, TypeScript modules in `src/models`, `src/api/routes`, and `src/api/server`.

---

## File Structure

- Modify `src/models/resolve.ts`
  - Add `UnknownModelProviderError`.
  - Add `SUPPORTED_MODEL_PREFIXES_MESSAGE`.
  - Add `createClientForProvider(model, provider)`.
  - Keep `createClient(model)` backward-compatible by delegating to the helper.

- Modify `src/api/routes/run.ts`
  - Import `UnknownModelProviderError` and `createClientForProvider`.
  - Resolve `provider` once after `GAUNTLET_MODELS` allow-list enforcement.
  - Return `400 { error: "unknown_model", message: "Model not supported. Supported prefixes: claude*, gpt*, o1*, o3*" }` only for `UnknownModelProviderError`.
  - Reuse `provider` in solo and multi-pass `executeRun` calls.

- Modify `src/api/server.ts`
  - Register a top-level `app.onError` JSON handler.

- Modify `test/models/resolve.test.ts`
  - Assert unknown models throw `UnknownModelProviderError` with code `unknown_model`.

- Modify `test/api/run.test.ts`
  - Assert unknown model prefixes return JSON 400, include `unknown_model`, and do not register an active run.

- Create `test/api/server.test.ts`
  - Assert the app-level error handler returns JSON 500 for unhandled route exceptions.

- Modify `docs/superpowers/specs/2026-05-05-unknown-model-json-400-design.md`
  - Already marked approved before plan execution.

---

## Task 1: Pin Model Resolver Typed Error

**Files:**
- Modify: `test/models/resolve.test.ts`

- [ ] **Step 1: Write the failing resolver test**

Change the import at the top of `test/models/resolve.test.ts` to:

```ts
import { describe, test, expect } from "bun:test";
import { UnknownModelProviderError, parseModelFlags, resolveProvider } from "../../src/models/resolve";
```

Replace the existing unknown-model test with:

```ts
  test("throws typed unknown-model error for unsupported prefixes", () => {
    expect(() => resolveProvider("unknown-model")).toThrow(UnknownModelProviderError);

    try {
      resolveProvider("unknown-model");
      throw new Error("expected resolveProvider to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownModelProviderError);
      expect((err as UnknownModelProviderError).code).toBe("unknown_model");
      expect((err as UnknownModelProviderError).message).toContain("claude*");
      expect((err as UnknownModelProviderError).message).toContain("gpt*");
      expect((err as UnknownModelProviderError).message).toContain("o1*");
      expect((err as UnknownModelProviderError).message).toContain("o3*");
    }
  });
```

- [ ] **Step 2: Run the resolver test and verify it fails**

Run:

```bash
bun test test/models/resolve.test.ts
```

Expected: FAIL because `UnknownModelProviderError` is not exported yet.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/models/resolve.test.ts
git commit -m "test(models): pin unknown model provider error"
```

---

## Task 2: Add Typed Provider Error And Client Helper

**Files:**
- Modify: `src/models/resolve.ts`

- [ ] **Step 1: Implement the typed error and helper**

Replace the current `createClient` / `resolveProvider` block in `src/models/resolve.ts` with:

```ts
export const SUPPORTED_MODEL_PREFIXES_MESSAGE = "Supported prefixes: claude*, gpt*, o1*, o3*";

export class UnknownModelProviderError extends Error {
  readonly code = "unknown_model";

  constructor(readonly model: string) {
    super(`Model not supported. ${SUPPORTED_MODEL_PREFIXES_MESSAGE}`);
    this.name = "UnknownModelProviderError";
  }
}

export function createClientForProvider(model: string, provider: Provider): LLMClient {
  switch (provider) {
    case "anthropic":
      return createAnthropicClient(model);
    case "openai":
      return createOpenAIClient(model);
  }
}

export function createClient(model: string): LLMClient {
  return createClientForProvider(model, resolveProvider(model));
}

export function resolveProvider(model: string): Provider {
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) {
    return "openai";
  }
  throw new UnknownModelProviderError(model);
}
```

Leave `parseModelFlags` unchanged.

- [ ] **Step 2: Run the resolver test and verify it passes**

Run:

```bash
bun test test/models/resolve.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit the implementation**

```bash
git add src/models/resolve.ts
git commit -m "fix(models): expose typed unknown model provider error"
```

---

## Task 3: Pin Run Route Unknown-Model Response

**Files:**
- Modify: `test/api/run.test.ts`

- [ ] **Step 1: Write the failing API route test**

Add this test after `POST /api/run/:id returns 400 when target is missing`:

```ts
  test("POST /api/run/:id returns JSON 400 for unknown model prefix before registering a run", async () => {
    const config = loadConfig({ projectRoot }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
    const registry = new ActiveRunRegistry();
    const app = new Hono();
    app.route("/api/run", runRoutes(config, undefined, undefined, registry));

    const res = await app.request("/api/run/story-001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "http://localhost:3000", model: "unknown-model" }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error).toBe("unknown_model");
    expect(body.message).toContain("claude*");
    expect(body.message).toContain("gpt*");
    expect(body.message).toContain("o1*");
    expect(body.message).toContain("o3*");
    expect(registry.list()).toEqual([]);
  });
```

- [ ] **Step 2: Run the route test and verify it fails**

Run:

```bash
bun test test/api/run.test.ts
```

Expected: FAIL. The new test should receive `500 text/plain` until the route is changed.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/api/run.test.ts
git commit -m "test(api): pin unknown model run response"
```

---

## Task 4: Resolve Provider Once In Run Route

**Files:**
- Modify: `src/api/routes/run.ts`

- [ ] **Step 1: Update imports**

Change the model import in `src/api/routes/run.ts` from:

```ts
import { createClient, resolveProvider } from "../../models/resolve";
```

to:

```ts
import {
  SUPPORTED_MODEL_PREFIXES_MESSAGE,
  UnknownModelProviderError,
  createClientForProvider,
  resolveProvider,
} from "../../models/resolve";
```

- [ ] **Step 2: Resolve provider before client construction**

Replace:

```ts
    const client = clientFactory
      ? clientFactory(effective.model)
      : createClient(effective.model);
```

with:

```ts
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
```

- [ ] **Step 3: Reuse provider in solo run execution**

In the solo `executeRun` call, replace:

```ts
        provider: resolveProvider(effective.model),
```

with:

```ts
        provider,
```

- [ ] **Step 4: Reuse provider in multi-pass run execution**

In the multi-pass `executeRun` call, replace:

```ts
          provider: resolveProvider(effective.model),
```

with:

```ts
          provider,
```

- [ ] **Step 5: Run focused tests and verify they pass**

Run:

```bash
bun test test/models/resolve.test.ts test/api/run.test.ts test/api/run-multi-pass.test.ts test/api/routes/run-snapshot.test.ts
```

Expected: PASS. This set covers the resolver, solo route, multi-pass route, and injected-client snapshot route.

- [ ] **Step 6: Commit the route fix**

```bash
git add src/api/routes/run.ts
git commit -m "fix(api): return JSON 400 for unknown run model"
```

---

## Task 5: Pin App-Level JSON 500 Backstop

**Files:**
- Create: `test/api/server.test.ts`

- [ ] **Step 1: Write the failing server error-handler test**

Create `test/api/server.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/api/server";
import { loadConfig } from "../../src/config";

describe("API server error handler", () => {
  test("returns JSON 500 for unhandled route exceptions", async () => {
    const config = loadConfig({ projectRoot: "." }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
    const app = createApp(config);
    app.get("/boom", () => {
      throw new Error("boom");
    });

    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error).toBe("internal");
    expect(body.message).toBe("boom");
  });
});
```

- [ ] **Step 2: Run the server test and verify it fails**

Run:

```bash
bun test test/api/server.test.ts
```

Expected: FAIL because `createApp` does not yet install an `onError` JSON handler.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/api/server.test.ts
git commit -m "test(api): pin JSON error backstop"
```

---

## Task 6: Add Hono JSON Error Handler

**Files:**
- Modify: `src/api/server.ts`

- [ ] **Step 1: Install the handler immediately after app creation**

In `createApp`, immediately after:

```ts
  const app = new Hono();
```

add:

```ts
  app.onError((err, c) => {
    return c.json({
      error: "internal",
      message: err instanceof Error ? err.message : String(err),
    }, 500);
  });
```

- [ ] **Step 2: Run the server test and verify it passes**

Run:

```bash
bun test test/api/server.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit the server backstop**

```bash
git add src/api/server.ts
git commit -m "fix(api): return JSON for unhandled API errors"
```

---

## Task 7: Final Verification And Corpus Notes

**Files:**
- Verify: `test/models/resolve.test.ts`
- Verify: `test/api/run.test.ts`
- Verify: `test/api/run-multi-pass.test.ts`
- Verify: `test/api/routes/run-snapshot.test.ts`
- Verify: `test/api/server.test.ts`
- Optional external workspace: `analysis-workspace/raw/specs/modules/http-routes-run.md`
- Optional external workspace: `contradictions-resolved.md`

- [ ] **Step 1: Run the focused verification suite**

Run:

```bash
bun test test/models/resolve.test.ts test/api/run.test.ts test/api/run-multi-pass.test.ts test/api/routes/run-snapshot.test.ts test/api/server.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the broader API test suite**

Run:

```bash
bun test test/api
```

Expected: PASS.

- [ ] **Step 3: Check for corpus files in this checkout**

Run:

```bash
rg -n "SPEC-RUNR-024|unknown model|unknown-model|contradictions-resolved|daemon" analysis-workspace docs
```

Expected in this checkout: `analysis-workspace` may be absent. If the command reports `analysis-workspace: No such file or directory`, do not create it. Update only files that exist in the current workspace.

- [ ] **Step 4: Commit any existing corpus updates**

If existing corpus/spec files were updated, commit them:

```bash
git add analysis-workspace docs
git commit -m "docs(spec): mark unknown model response resolved"
```

If no corpus/spec files exist in this checkout, skip this commit.

- [ ] **Step 5: Final status check**

Run:

```bash
git status --short
```

Expected: only unrelated pre-existing untracked files remain. The files touched by this plan are committed or intentionally staged for review.
