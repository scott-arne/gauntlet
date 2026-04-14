# Gauntlet AppConfig Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Gauntlet's scattered runtime configuration (per-command argv structs, module-level globals, env vars captured at module-load into frozen consts) with a single coherent `AppConfig` loaded once at startup. Fix the silent-flag-drop bug, fix the host-override.js freeze-at-module-load trap, and land the `gauntlet config` / `GET /api/config/effective` inspection commands. Addresses [PRI-1128](https://linear.app/prime-radiant/issue/PRI-1128).

**Architecture:**
- **Two seams, both pure functions.** `loadConfig(argv, env) → AppConfig` is the *only* thing in the codebase that reads `process.env` for Gauntlet-level config. `mergeRunConfig(app, body) → EffectiveRunConfig` is the *only* thing that knows about per-request overrides. Everything downstream takes explicit values.
- **Precedence rule (explicit):** `defaults < env vars < CLI flags < per-request body (web only)`.
- **Web override allow-list:** `mergeRunConfig` validates the POST body against an explicit allow-list. Unknown fields → 400. Every field exposed to the web is a conscious decision.
- **SDK env pass-through policy:** Gauntlet reads `GAUNTLET_*` env into `AppConfig`. SDK-native env vars (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, etc.) are consumed by the SDKs directly — Gauntlet never shadows, wraps, or re-exports them. The "empty constructor" pattern (`new Anthropic()`, `new OpenAI()`) is preserved as policy.
- **Flag hygiene micropatch ships first** (Tasks 1-2). The rest of the refactor builds on that foundation.
- **Minimal chrome-ws-lib change only.** This plan adds a `setEndpoint(host, port)` seam so `WebAdapter` can pass explicit values. Full refactor of `chrome-ws-lib`'s module-level `let activePort` into per-instance state is deliberately deferred to a follow-up ticket (PR 2 per PRI-1128).

**Tech Stack:** Bun + Hono (server), TypeScript throughout, `bun:test`. The existing `host-override.js` / `chrome-ws-lib.js` are CommonJS and must stay that way (CDP client interop).

---

## File Structure

**New files:**
- `src/config.ts` — `AppConfig` type, `loadConfig(argv, env)`, `mergeRunConfig(app, body)`, `validateRunBodyAllowList(body)` helpers
- `src/cli/config-command.ts` — `runConfigCommand()` for the `gauntlet config` CLI subcommand
- `src/api/routes/config-effective.ts` — `GET /api/config/effective` route
- `test/config.test.ts` — unit tests for `loadConfig` + `mergeRunConfig`
- `test/cli/args-hygiene.test.ts` — tests for unknown-flag rejection across all parsers
- `test/cli/config-command.test.ts` — tests for `gauntlet config` output shape
- `test/api/config-effective.test.ts` — route test

**Modified files:**
- `src/cli/args.ts` — per-command allow-lists, unknown-flag rejection, accept `--chrome`/`--target`/`--model` on `serve`, accept `--data-dir` on both
- `src/index.ts` — call `loadConfig()` once; pass `AppConfig` to `createApp`; add `config` subcommand dispatch
- `src/api/server.ts` — `createApp(config: AppConfig, broadcaster?, registry?)`; thread config slices to route factories
- `src/api/routes/run.ts` — take config, use `mergeRunConfig`, validate allow-list, pass explicit `{host, port}` to `WebAdapter`
- `src/api/routes/config.ts` — unchanged (still returns `{models, defaultModel}` for the UI picker)
- `src/adapters/web/adapter.ts` — constructor takes `{host, port}` explicitly, no `process.env` mutation, calls `chrome.setEndpoint(host, port)` once
- `src/adapters/web/lib/host-override.js` — convert `CHROME_DEBUG_HOST`/`CHROME_DEBUG_PORT`/`WS_OVERRIDE_ENABLED` from `const`-at-module-load to mutable state with a `setDefaults(host, port)` setter
- `src/adapters/web/lib/chrome-ws-lib.js` — add `setEndpoint(host, port)` that updates `activePort` and calls into host-override's setter; rewrite internals that read const captures to read current values via getters
- `src/models/anthropic.ts` / `src/models/openai.ts` — unchanged; the hand-rolled API-key checks are intentionally retained as defense-in-depth alongside `requireLlmCapable` in `loadConfig`.
- `src/models/resolve.ts` — keep `createClient` / `resolveProvider` as-is; `parseModelFlags` stays for backward compatibility of the `--model role=value` syntax but is now called from inside `loadConfig` instead of `parseArgs`
- `src/cli/run.ts` (or wherever `parsedArgs.command === "run"` is handled in index.ts) — pass `AppConfig` into adapter construction
- `README.md` — new "Configuration" section: precedence rule, flag table per command, env var table, SDK env pass-through policy, `gauntlet config` usage
- `test/models/resolve.test.ts` — update the `parseModelFlags > uses defaults` test to not rely on process env; hoist the test into `loadConfig` tests where appropriate

---

## Task 1: Flag allow-list + unknown-flag rejection (micropatch)

**Purpose:** Ship the "silent flag drop" fix first, independent of the rest of the refactor. This can cherry-pick to main ahead of the larger PR if needed.

**Files:**
- Modify: `src/cli/args.ts`
- Create: `test/cli/args-hygiene.test.ts`

**Contract:** Each command's parser knows its allow-list of valid flags. `parseFlags` continues to collect freely, but each parser then validates the resulting dict against its allow-list and throws on unknown keys. Error message includes the unknown flag name and the list of valid flags. Exit code 2 from `main()` on parse error is already handled by the top-level catch.

- [ ] **Step 1: Write failing tests** in `test/cli/args-hygiene.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { parseArgs } from "../../src/cli/args";

describe("CLI flag hygiene", () => {
  test("parseServeArgs rejects unknown flag", () => {
    expect(() => parseArgs(["bun", "gauntlet", "serve", "--bogus", "x"]))
      .toThrow(/unknown flag.*--bogus/i);
  });

  test("parseServeArgs accepts --chrome, --data-dir, --port, --model, --target", () => {
    const args = parseArgs([
      "bun", "gauntlet", "serve",
      "--port", "4400",
      "--data-dir", "/tmp/x",
      "--chrome", "localhost:9222",
      "--model", "agent=claude-sonnet-4-6",
      "--target", "http://localhost:3000",
    ]);
    expect(args.command).toBe("serve");
    // Specific field assertions come in Task 3 after AppConfig shape is set.
  });

  test("parseRunArgs rejects unknown flag", () => {
    expect(() => parseArgs(["bun", "gauntlet", "run", "foo.md", "--target", "http://x", "--nope", "y"]))
      .toThrow(/unknown flag.*--nope/i);
  });

  test("parseRunArgs accepts --target, --model, --chrome, --adapter, --out", () => {
    const args = parseArgs([
      "bun", "gauntlet", "run", "foo.md",
      "--target", "http://localhost:3000",
      "--model", "agent=claude-sonnet-4-6",
      "--chrome", "localhost:9222",
      "--adapter", "web",
      "--out", "/tmp/out",
    ]);
    expect(args.command).toBe("run");
  });

  test("parseFanoutArgs rejects unknown flag", () => {
    expect(() => parseArgs(["bun", "gauntlet", "fanout", "foo.md", "--bogus", "y"]))
      .toThrow(/unknown flag.*--bogus/i);
  });

  test("parseValidateArgs rejects unknown flag", () => {
    expect(() => parseArgs(["bun", "gauntlet", "validate", "foo.md", "--bogus", "y"]))
      .toThrow(/unknown flag.*--bogus/i);
  });

  test("error mentions valid flags for command", () => {
    try {
      parseArgs(["bun", "gauntlet", "serve", "--bogus", "x"]);
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/--port/);
      expect(msg).toMatch(/--data-dir/);
      expect(msg).toMatch(/--chrome/);
    }
  });
});
```

- [ ] **Step 2: Run the tests — confirm they fail.** `bun test test/cli/args-hygiene.test.ts`

- [ ] **Step 3: Implement the allow-list check.**

Add per-command allow-list constants at the top of `src/cli/args.ts`:

```ts
const RUN_ALLOWED = new Set(["target", "out", "adapter", "model", "chrome"]);
const VALIDATE_ALLOWED = new Set<string>([]);
const FANOUT_ALLOWED = new Set(["out", "model", "from-result"]);
const SERVE_ALLOWED = new Set(["port", "data-dir", "chrome", "target", "model"]);
```

Add a helper:

```ts
function rejectUnknownFlags(
  flags: Record<string, unknown>,
  allowed: Set<string>,
  command: string,
): void {
  const unknown = Object.keys(flags).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    const validList = [...allowed].sort().map((f) => `--${f}`).join(", ");
    throw new Error(
      `Unknown flag${unknown.length > 1 ? "s" : ""} for "gauntlet ${command}": ${unknown.map((f) => `--${f}`).join(", ")}\n\nValid flags: ${validList || "(none)"}`,
    );
  }
}
```

Call it at the top of each `parseXxxArgs` after `parseFlags(args)`. The `model` flag lands in the dict as an array key `model` (via the special-case in `parseFlags`), so the set includes `"model"` for commands that accept it.

Update `parseServeArgs` to accept the new fields — but *don't* wire them into `ServeArgs` yet (that happens in Task 3 when `AppConfig` lands). For now, the parser just accepts them without error, and `parseServeArgs` returns the same `ServeArgs` as before. This keeps Task 1 purely additive and minimally invasive.

- [ ] **Step 4: Run tests — confirm they pass.** `bun test test/cli/args-hygiene.test.ts`

- [ ] **Step 5: Run full suite.** `bun test`. Existing tests should still pass (the pre-existing `parseModelFlags > uses defaults when not specified` failure is known, ignore it — we'll address it in Task 3).

- [ ] **Step 6: Commit.**

```
git add src/cli/args.ts test/cli/args-hygiene.test.ts
git commit -m "fix: reject unknown CLI flags loudly across all commands"
```

---

## Task 2: `AppConfig` type and `loadConfig` core

**Files:**
- Create: `src/config.ts`
- Create: `test/config.test.ts`

**Contract:**

```ts
// src/config.ts
export interface ChromeEndpoint {
  host: string;
  port: number;
}

export interface AppConfig {
  dataDir: string;
  port: number;             // server port for `serve`; ignored for `run`
  defaultChrome: ChromeEndpoint;  // always set, defaults to { host: "127.0.0.1", port: 9222 }
  models: {
    agent: string;
    fanout?: string;
    available: string[];    // from GAUNTLET_MODELS or [agent]
  };
  apiKeys: {
    anthropic: boolean;     // presence only
    openai: boolean;
  };
  // Source attribution: which layer set each top-level field.
  // Used by `gauntlet config` for "why is this wrong" debugging.
  sources: {
    dataDir: "default" | "env" | "flag";
    port: "default" | "env" | "flag";
    defaultChrome: "default" | "env" | "flag";
    "models.agent": "default" | "env" | "flag";
    "models.fanout": "default" | "env" | "flag" | "unset";
    "models.available": "default" | "env" | "flag";
  };
}

export interface CliArgsInput {
  dataDir?: string;
  port?: number;
  chrome?: string;          // "host:port" raw from --chrome
  target?: string;          // used by run command; serve's --target becomes a default that the UI hints at
  models?: { agent?: string; fanout?: string };
}

export function loadConfig(args: CliArgsInput, env: NodeJS.ProcessEnv): AppConfig {
  // Implementation per precedence rule:
  //   defaults < env vars < CLI flags
  //
  // API key check: warn (not throw) if neither ANTHROPIC_API_KEY nor OPENAI_API_KEY
  // is set. Throwing would break `gauntlet config`'s ability to introspect a
  // broken env. The actual throw-on-use happens when createClient() is called.
  // Presence is recorded in apiKeys.* for inspection output.
}
```

**Default values:**
- `dataDir`: `"."` if nothing provided
- `port`: `4400`
- `defaultChrome`: `{ host: "127.0.0.1", port: 9222 }`
- `models.agent`: `"claude-sonnet-4-6"`
- `models.fanout`: `undefined`
- `models.available`: `[config.models.agent]` (the single known model) if `GAUNTLET_MODELS` is unset

**Env vars consumed (Gauntlet-prefixed):**
- `GAUNTLET_PORT` → `port`
- `GAUNTLET_AGENT_MODEL` → `models.agent`
- `GAUNTLET_FANOUT_MODEL` → `models.fanout`
- `GAUNTLET_MODELS` → `models.available` (comma-separated list)
- `GAUNTLET_CHROME` → `defaultChrome` (format: `host:port`, new env var — document it)
- `GAUNTLET_DATA_DIR` → `dataDir` (new env var — matches `--data-dir` flag, useful for compose)

**Env vars NOT consumed (pass-through to SDKs):**
- `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_LOG` — not read, only presence-checked for `apiKeys.anthropic`
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT` — same
- `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` — never read; the SDKs handle these directly

- [ ] **Step 1: Write failing tests** in `test/config.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  const emptyEnv = {} as NodeJS.ProcessEnv;

  test("all defaults when no args and empty env", () => {
    const c = loadConfig({}, emptyEnv);
    expect(c.dataDir).toBe(".");
    expect(c.port).toBe(4400);
    expect(c.defaultChrome).toEqual({ host: "127.0.0.1", port: 9222 });
    expect(c.models.agent).toBe("claude-sonnet-4-6");
    expect(c.models.fanout).toBeUndefined();
    expect(c.models.available).toEqual(["claude-sonnet-4-6"]);
    expect(c.apiKeys).toEqual({ anthropic: false, openai: false });
    expect(c.sources.dataDir).toBe("default");
  });

  test("env vars override defaults", () => {
    const c = loadConfig({}, {
      GAUNTLET_PORT: "5500",
      GAUNTLET_AGENT_MODEL: "gpt-4o",
      GAUNTLET_DATA_DIR: "/data",
      GAUNTLET_CHROME: "chrome-svc:9333",
      GAUNTLET_MODELS: "claude-sonnet-4-6,gpt-4o",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    } as NodeJS.ProcessEnv);
    expect(c.port).toBe(5500);
    expect(c.models.agent).toBe("gpt-4o");
    expect(c.dataDir).toBe("/data");
    expect(c.defaultChrome).toEqual({ host: "chrome-svc", port: 9333 });
    expect(c.models.available).toEqual(["claude-sonnet-4-6", "gpt-4o"]);
    expect(c.apiKeys.anthropic).toBe(true);
    expect(c.apiKeys.openai).toBe(false);
    expect(c.sources.port).toBe("env");
    expect(c.sources["models.agent"]).toBe("env");
  });

  test("CLI args override env vars", () => {
    const c = loadConfig(
      { port: 6600, dataDir: "/flag", chrome: "flag-host:9444", models: { agent: "claude-opus-4-6" } },
      { GAUNTLET_PORT: "5500", GAUNTLET_DATA_DIR: "/env", GAUNTLET_CHROME: "env:9333", GAUNTLET_AGENT_MODEL: "gpt-4o" } as NodeJS.ProcessEnv,
    );
    expect(c.port).toBe(6600);
    expect(c.dataDir).toBe("/flag");
    expect(c.defaultChrome).toEqual({ host: "flag-host", port: 9444 });
    expect(c.models.agent).toBe("claude-opus-4-6");
    expect(c.sources.port).toBe("flag");
    expect(c.sources.dataDir).toBe("flag");
    expect(c.sources.defaultChrome).toBe("flag");
    expect(c.sources["models.agent"]).toBe("flag");
  });

  test("invalid GAUNTLET_CHROME format throws", () => {
    expect(() => loadConfig({}, { GAUNTLET_CHROME: "no-port-here" } as NodeJS.ProcessEnv))
      .toThrow(/GAUNTLET_CHROME/);
  });

  test("invalid --chrome format throws", () => {
    expect(() => loadConfig({ chrome: "no-port-here" }, emptyEnv))
      .toThrow(/chrome/i);
  });

  test("invalid port in env throws", () => {
    expect(() => loadConfig({}, { GAUNTLET_PORT: "not-a-number" } as NodeJS.ProcessEnv))
      .toThrow(/GAUNTLET_PORT/);
  });

  test("available models falls back to [agent] when GAUNTLET_MODELS unset", () => {
    const c = loadConfig({}, { GAUNTLET_AGENT_MODEL: "gpt-4o" } as NodeJS.ProcessEnv);
    expect(c.models.available).toEqual(["gpt-4o"]);
  });

  test("apiKeys reflects both providers when both keys set", () => {
    const c = loadConfig({}, { ANTHROPIC_API_KEY: "sk-ant-xxx", OPENAI_API_KEY: "sk-xxx" } as NodeJS.ProcessEnv);
    expect(c.apiKeys).toEqual({ anthropic: true, openai: true });
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail.** `bun test test/config.test.ts`

- [ ] **Step 3: Implement `loadConfig`** in `src/config.ts`. Follow the contract above. Use small pure helpers (`parseChromeEndpoint(raw)`, `parsePortNumber(raw, label)`) for the validation bits.

- [ ] **Step 4: Run tests — confirm they pass.**

- [ ] **Step 5: Commit.**

```
git add src/config.ts test/config.test.ts
git commit -m "feat: add AppConfig type and loadConfig with precedence + source tracking"
```

---

## Task 3: `mergeRunConfig` with web allow-list

**Files:**
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`

**Contract:**

```ts
// Added to src/config.ts
export interface RunRequestBody {
  target: string;
  model?: string;
  chrome?: string;
  adapter?: "web" | "cli" | "tui";
}

export interface EffectiveRunConfig {
  target: string;
  model: string;
  chrome: ChromeEndpoint;
  adapter: "web" | "cli" | "tui";
  dataDir: string;
}

const RUN_BODY_ALLOWED = new Set(["target", "model", "chrome", "adapter"]);

export function validateRunBody(body: unknown): RunRequestBody {
  if (!body || typeof body !== "object") {
    throw new Error("run request body must be an object");
  }
  const bodyObj = body as Record<string, unknown>;
  const unknown = Object.keys(bodyObj).filter((k) => !RUN_BODY_ALLOWED.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown field${unknown.length > 1 ? "s" : ""} in run request body: ${unknown.join(", ")}. Allowed: ${[...RUN_BODY_ALLOWED].join(", ")}`,
    );
  }
  if (typeof bodyObj.target !== "string" || !bodyObj.target) {
    throw new Error("run request body: target is required and must be a non-empty string");
  }
  // Light shape validation on optional fields; `mergeRunConfig` does the rest.
  return {
    target: bodyObj.target,
    model: typeof bodyObj.model === "string" ? bodyObj.model : undefined,
    chrome: typeof bodyObj.chrome === "string" ? bodyObj.chrome : undefined,
    adapter: bodyObj.adapter as EffectiveRunConfig["adapter"] | undefined,
  };
}

export function mergeRunConfig(app: AppConfig, body: RunRequestBody): EffectiveRunConfig {
  const chrome = body.chrome ? parseChromeEndpoint(body.chrome, "body.chrome") : app.defaultChrome;
  return {
    target: body.target,
    model: body.model ?? app.models.agent,
    chrome,
    adapter: body.adapter ?? "web",
    dataDir: app.dataDir,
  };
}
```

- [ ] **Step 1: Write failing tests,** add to `test/config.test.ts`:

```ts
import { validateRunBody, mergeRunConfig, loadConfig } from "../src/config";

describe("validateRunBody", () => {
  test("accepts minimal body with just target", () => {
    expect(validateRunBody({ target: "http://x" })).toEqual({
      target: "http://x",
      model: undefined,
      chrome: undefined,
      adapter: undefined,
    });
  });

  test("accepts full allowed body", () => {
    const b = validateRunBody({
      target: "http://x",
      model: "gpt-4o",
      chrome: "localhost:9333",
      adapter: "web",
    });
    expect(b.target).toBe("http://x");
    expect(b.model).toBe("gpt-4o");
    expect(b.chrome).toBe("localhost:9333");
    expect(b.adapter).toBe("web");
  });

  test("rejects unknown field", () => {
    expect(() => validateRunBody({ target: "http://x", screenshotQuality: 99 }))
      .toThrow(/Unknown field.*screenshotQuality/);
  });

  test("rejects missing target", () => {
    expect(() => validateRunBody({})).toThrow(/target/);
  });

  test("rejects non-string target", () => {
    expect(() => validateRunBody({ target: 123 })).toThrow(/target/);
  });

  test("rejects non-object body", () => {
    expect(() => validateRunBody(null)).toThrow(/object/);
    expect(() => validateRunBody("string")).toThrow(/object/);
  });
});

describe("mergeRunConfig", () => {
  const app = loadConfig({}, { GAUNTLET_CHROME: "server-default:9000", GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);

  test("falls through to server defaults when body has only target", () => {
    const eff = mergeRunConfig(app, { target: "http://x" });
    expect(eff.target).toBe("http://x");
    expect(eff.model).toBe("claude-sonnet-4-6");
    expect(eff.chrome).toEqual({ host: "server-default", port: 9000 });
    expect(eff.adapter).toBe("web");
  });

  test("body chrome overrides server default", () => {
    const eff = mergeRunConfig(app, { target: "http://x", chrome: "override:9333" });
    expect(eff.chrome).toEqual({ host: "override", port: 9333 });
  });

  test("body model overrides server default", () => {
    const eff = mergeRunConfig(app, { target: "http://x", model: "gpt-4o" });
    expect(eff.model).toBe("gpt-4o");
  });

  test("invalid chrome format in body throws", () => {
    expect(() => mergeRunConfig(app, { target: "http://x", chrome: "no-port" }))
      .toThrow(/chrome/i);
  });
});
```

- [ ] **Step 2: Run tests — fail.**

- [ ] **Step 3: Implement `validateRunBody` and `mergeRunConfig`** per the contract.

- [ ] **Step 4: Run tests — pass.**

- [ ] **Step 5: Commit.**

```
git add src/config.ts test/config.test.ts
git commit -m "feat: add mergeRunConfig and web allow-list validator"
```

---

## Task 4: Wire `loadConfig` into CLI arg parsers

**Purpose:** Now that `AppConfig` exists, teach `parseServeArgs` and `parseRunArgs` to produce the new structured input that `loadConfig` consumes. The CLI args types become thin wrappers around `CliArgsInput`.

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `test/cli/args-hygiene.test.ts` (extend the existing accept-tests to assert field shape)

- [ ] **Step 1:** Update `ServeArgs` and `RunArgs` to carry the full structured input:

```ts
export interface ServeArgs {
  command: "serve";
  cli: CliArgsInput;
}

export interface RunArgs {
  command: "run";
  scenarioPath: string;
  outDir: string;         // --out, separate from AppConfig.dataDir
  adapter: "web" | "cli" | "tui";
  cli: CliArgsInput;
}
```

`FanoutArgs` and `ValidateArgs` stay as-is for now — they don't yet need `AppConfig`. (Follow-up: fold them in too, out of scope for this task.)

- [ ] **Step 2:** Rewrite `parseServeArgs` and `parseRunArgs` to populate `cli: CliArgsInput`:

```ts
function parseServeArgs(args: string[]): ServeArgs {
  const flags = parseFlags(args);
  rejectUnknownFlags(flags, SERVE_ALLOWED, "serve");
  return {
    command: "serve",
    cli: {
      dataDir: flags["data-dir"],
      port: flags.port ? parseInt(flags.port, 10) : undefined,
      chrome: flags.chrome,
      target: flags.target,
      models: parseModelFlagArray(flags.model),
    },
  };
}

function parseRunArgs(args: string[]): RunArgs {
  const positional = extractPositional(args);
  if (!positional) throw new Error("Missing scenario path\n\nUsage: gauntlet run <scenario.md> --target <url>");
  const flags = parseFlags(args);
  rejectUnknownFlags(flags, RUN_ALLOWED, "run");
  if (!flags.target) throw new Error("Missing required flag: --target <url>");
  return {
    command: "run",
    scenarioPath: positional,
    outDir: flags.out ?? "./evidence",
    adapter: (flags.adapter as "web" | "cli" | "tui") ?? "web",
    cli: {
      dataDir: flags["data-dir"],
      chrome: flags.chrome,
      target: flags.target,
      models: parseModelFlagArray(flags.model),
    },
  };
}

function parseModelFlagArray(modelFlags: string[] | undefined): { agent?: string; fanout?: string } | undefined {
  if (!modelFlags || modelFlags.length === 0) return undefined;
  const out: { agent?: string; fanout?: string } = {};
  for (const flag of modelFlags) {
    const idx = flag.indexOf("=");
    if (idx === -1) continue;
    const role = flag.slice(0, idx);
    const model = flag.slice(idx + 1);
    if (role === "agent") out.agent = model;
    else if (role === "fanout") out.fanout = model;
  }
  return out;
}
```

Note: `parseModelFlagArray` replaces `parseModelFlags` for this code path. `parseModelFlags` in `src/models/resolve.ts` is kept for backward compatibility with anything that still imports it, but it should no longer read from `process.env` — it just parses the flag array. Delete its `process.env` fallback; `loadConfig` is the only place env gets read now.

- [ ] **Step 3: Fix the broken `parseModelFlags` test** in `test/models/resolve.test.ts`. The `uses defaults when not specified` test expected `claude-sonnet-4-6` and was failing because of env leakage. After this change, `parseModelFlags([])` returns `{}` (no env fallback). Update the test:

```ts
test("parseModelFlags returns empty object when no flags provided", () => {
  const config = parseModelFlags([]);
  expect(config).toEqual({});
});

test("parseModelFlags parses agent flag", () => {
  expect(parseModelFlags(["agent=claude-opus-4-6"])).toEqual({ agent: "claude-opus-4-6" });
});

test("parseModelFlags parses fanout flag", () => {
  expect(parseModelFlags(["fanout=gpt-4o"])).toEqual({ fanout: "gpt-4o" });
});
```

Delete the "uses defaults when not specified" test — defaults are now `loadConfig`'s job.

- [ ] **Step 4: Update other callers of `parseModelFlags`** in `src/cli/args.ts` (fanout command still uses it directly) — leave fanout alone for now; it's out of scope. Just ensure the fanout path still compiles.

- [ ] **Step 5: Run full test suite.** The pre-existing failure should now be resolved. New `args-hygiene` tests should still pass.

- [ ] **Step 6: Commit.**

```
git add src/cli/args.ts src/models/resolve.ts test/models/resolve.test.ts test/cli/args-hygiene.test.ts
git commit -m "refactor: parseServeArgs and parseRunArgs produce CliArgsInput for loadConfig"
```

---

## Task 5: Thread `AppConfig` through `createApp` and route factories

**Files:**
- Modify: `src/api/server.ts`
- Modify: `src/api/routes/run.ts`
- Modify: `src/index.ts` (serve command dispatch)

- [ ] **Step 1:** Update `createApp` signature:

```ts
// src/api/server.ts
import type { AppConfig } from "../config";

export function createApp(
  config: AppConfig,
  uiDir?: string,
  broadcaster?: RunBroadcaster,
  registry?: ActiveRunRegistry,
) {
  const app = new Hono();
  const errorLog = new ErrorLog();

  const api = new Hono();
  api.route("/scenarios", scenarioRoutes(config.dataDir));
  api.route("/results", resultRoutes(join(config.dataDir, "results")));
  api.route("/fanout", fanoutRoutes(config.dataDir, undefined, errorLog));
  api.route("/run", runRoutes(config, broadcaster, errorLog, registry));
  api.route("/config", configRoutes());
  api.route("/errors", errorRoutes(errorLog));
  if (registry) api.route("/runs/active", activeRunRoutes(registry));

  app.route("/api", api);
  // ... static-serving unchanged ...
  return app;
}
```

- [ ] **Step 2:** Update `runRoutes` to take `AppConfig` instead of `dataDir`:

```ts
// src/api/routes/run.ts
import { mergeRunConfig, validateRunBody, type AppConfig } from "../../config";

export function runRoutes(
  config: AppConfig,
  broadcaster?: RunBroadcaster,
  errorLog?: ErrorLog,
  registry?: ActiveRunRegistry,
) {
  const router = new Hono();
  const storiesDir = join(config.dataDir, "stories");

  router.post("/:id", async (c) => {
    const entry = findCard(storiesDir, c.req.param("id"));
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

    // Model must be known (if GAUNTLET_MODELS was set, validate against it)
    if (config.models.available.length > 0 && !config.models.available.includes(effective.model)) {
      return c.json({ error: `model "${effective.model}" is not in GAUNTLET_MODELS allow-list` }, 400);
    }

    const client = createClient(effective.model);
    const adapter = createAdapter(effective.adapter, effective.chrome);
    const outDir = join(config.dataDir, "results", entry.card.id);
    const startedAt = Date.now();

    if (registry) {
      registry.register({
        id: entry.card.id,
        title: entry.card.title,
        target: effective.target,
        model: effective.model,
        startedAt,
      });
    }

    executeRun({
      card: entry.card,
      adapter,
      adapterType: effective.adapter,
      client,
      target: effective.target,
      outDir,
      broadcaster,
      registry,
      errorLog,
      startedAt,
    }).catch(/* existing */);

    return c.json({ id: entry.card.id }, 202);
  });

  return router;
}
```

Also update `createAdapter` to take `ChromeEndpoint` instead of `string`:

```ts
function createAdapter(type: string, chrome?: ChromeEndpoint): Adapter {
  switch (type) {
    case "cli": return new CLIAdapter();
    case "tui": return new TUIAdapter();
    case "web": return new WebAdapter({ chrome });
    default: throw new Error(`Unknown adapter type: ${type}`);
  }
}
```

`WebAdapter` is updated in Task 6. For now, keep it accepting the old `string` shape and convert at the callsite (`chrome ? \`${chrome.host}:${chrome.port}\` : undefined`). Or pre-emptively update `WebAdapter` now in this task — either is fine, but doing it in Task 6 keeps this task focused.

- [ ] **Step 3:** Update `src/index.ts` serve dispatch to call `loadConfig` and pass it to `createApp`:

```ts
case "serve": {
  const { createApp } = await import("./api/server");
  const { RunBroadcaster } = await import("./api/ws");
  const { ActiveRunRegistry } = await import("./api/active-runs");
  const { loadConfig } = await import("./config");
  const { join } = await import("path");

  const config = loadConfig(args.cli, process.env);

  const uiDir = join(import.meta.dir, "..", "ui", "dist");
  const broadcaster = new RunBroadcaster();
  const registry = new ActiveRunRegistry();
  const app = createApp(config, uiDir, broadcaster, registry);

  if (config.models.available.length === 0) {
    console.error("WARNING: No model configured. Set GAUNTLET_AGENT_MODEL or GAUNTLET_MODELS environment variable.");
  }
  console.error(`gauntlet server listening on port ${config.port}`);

  Bun.serve({
    port: config.port,
    // ... existing upgrade handler + ws handlers unchanged ...
  });
  break;
}
```

- [ ] **Step 4:** Update existing run-route tests in `test/api/run.test.ts` to construct an `AppConfig` via `loadConfig` and pass it to `runRoutes` instead of `dataDir`:

```ts
import { loadConfig } from "../../src/config";

// in each test:
const config = loadConfig({ dataDir }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
app.route("/api/run", runRoutes(config));
```

- [ ] **Step 5: Run full test suite.** Expected: all green except any pre-existing unrelated failures.

- [ ] **Step 6: Run `cd ui && bun run build`** — no TypeScript errors.

- [ ] **Step 7: Commit.**

```
git add src/api/server.ts src/api/routes/run.ts src/index.ts test/api/run.test.ts
git commit -m "refactor: thread AppConfig through createApp and runRoutes"
```

---

## Task 6: WebAdapter takes explicit `{host, port}` + retire module-load env reading

**Files:**
- Modify: `src/adapters/web/adapter.ts`
- Modify: `src/adapters/web/lib/host-override.js`
- Modify: `src/adapters/web/lib/chrome-ws-lib.js`
- Modify: `src/api/routes/run.ts` (update the `createAdapter` callsite from Task 5 if it still converts to a string)

- [ ] **Step 1:** Update `WebAdapter`:

```ts
// src/adapters/web/adapter.ts
import type { ChromeEndpoint } from "../../config";

const chrome = require("./lib/chrome-ws-lib");

export interface WebAdapterOptions {
  chrome?: ChromeEndpoint;
}

export class WebAdapter implements Adapter {
  private remote: boolean;

  constructor(options?: WebAdapterOptions) {
    this.remote = false;
    if (options?.chrome) {
      chrome.setEndpoint(options.chrome.host, options.chrome.port);
      this.remote = true;
    }
    // If no chrome passed, chrome-ws-lib uses its startup defaults
    // (which, after this refactor, come from host-override.js's mutable state
    // — set via setEndpoint during loadConfig).
  }
  // rest unchanged
}
```

- [ ] **Step 2:** Update `host-override.js` to mutable state:

```js
// src/adapters/web/lib/host-override.js
const DEFAULT_PORT = 9222;
const DEFAULT_HOST = '127.0.0.1';

let debugHost = process.env.CHROME_WS_HOST || DEFAULT_HOST;
let debugPort = (() => {
  const parsed = parseInt(process.env.CHROME_WS_PORT || `${DEFAULT_PORT}`, 10);
  return Number.isNaN(parsed) ? DEFAULT_PORT : parsed;
})();
let overrideEnabled = process.env.CHROME_WS_HOST !== undefined || process.env.CHROME_WS_PORT !== undefined;

function setDefaults(host, port) {
  debugHost = host;
  debugPort = port;
  overrideEnabled = true;
}

function getHost() { return debugHost; }
function getPort() { return debugPort; }
function getBase() { return `http://${debugHost}:${debugPort}`; }
function isOverrideEnabled() { return overrideEnabled; }

function rewriteWsUrl(originalUrl, host, port) {
  if (!originalUrl || typeof originalUrl !== 'string') return originalUrl;
  if (!overrideEnabled) return originalUrl;
  const useHost = host !== undefined ? host : debugHost;
  const usePort = port !== undefined ? port : debugPort;
  try {
    const url = new URL(originalUrl);
    url.hostname = useHost;
    url.port = `${usePort}`;
    return url.toString();
  } catch {
    return originalUrl;
  }
}

module.exports = {
  setDefaults,
  getHost,
  getPort,
  getBase,
  isOverrideEnabled,
  rewriteWsUrl,
};
```

Notice: the top-level `CHROME_DEBUG_HOST`/`CHROME_DEBUG_PORT`/`CHROME_DEBUG_BASE` exports are **gone**. Anything that was reading those named exports now needs to call `getHost()`/`getPort()`/`getBase()`. This will touch several lines of `chrome-ws-lib.js`.

- [ ] **Step 3:** Update `chrome-ws-lib.js` to use the getter functions and add `setEndpoint`:

At the top of `chrome-ws-lib.js`:

```js
const hostOverride = require('./host-override');
const { rewriteWsUrl } = hostOverride;

// activePort now tracks the port chrome-ws-lib is actively using.
// Defaults to the host-override port, which in turn defaults to env or 9222.
let activePort = hostOverride.getPort();

function setEndpoint(host, port) {
  hostOverride.setDefaults(host, port);
  activePort = port;
}

// ... rest of module ...
```

Search the file for uses of `CHROME_DEBUG_HOST`, `CHROME_DEBUG_PORT`, `CHROME_DEBUG_BASE` — all destructured from `require('./host-override')` at the top. Replace each reference with `hostOverride.getHost()`, `hostOverride.getPort()`, `hostOverride.getBase()`.

Export `setEndpoint` in the module's existing `module.exports` block.

- [ ] **Step 4:** Sanity-test manually: start the server with `--chrome nonsense:9333` and confirm it *does not* silently drive the desktop Chrome at 9222. (This is the bug the ticket was filed about.) Then start with the default and confirm it works as before.

```bash
# Should fail with a clear "can't reach nonsense:9333" style error, not succeed
GAUNTLET_AGENT_MODEL=claude-sonnet-4-6 bun run src/index.ts serve \
  --data-dir /tmp/gauntlet-test --port 14401 --chrome nonsense:9333
```

- [ ] **Step 5: Run full test suite.** The existing `WebAdapter` tests (if any) and integration tests should still pass.

- [ ] **Step 6: Run `cd ui && bun run build`.**

- [ ] **Step 7: Commit.**

```
git add src/adapters/web/adapter.ts src/adapters/web/lib/host-override.js src/adapters/web/lib/chrome-ws-lib.js src/api/routes/run.ts
git commit -m "fix: WebAdapter takes explicit ChromeEndpoint; retire const-at-load env reads"
```

---

## Task 7: `gauntlet config` CLI subcommand

**Files:**
- Create: `src/cli/config-command.ts`
- Create: `test/cli/config-command.test.ts`
- Modify: `src/cli/args.ts` — add `config` command and parser
- Modify: `src/index.ts` — dispatch new command

- [ ] **Step 1:** Add the `config` command to `src/cli/args.ts`:

```ts
export interface ConfigArgs {
  command: "config";
  json: boolean;
  cli: CliArgsInput;
}

// Add to ParsedArgs union, add case in parseArgs switch.

const CONFIG_ALLOWED = new Set(["json", "data-dir", "port", "chrome", "target", "model"]);

function parseConfigArgs(args: string[]): ConfigArgs {
  const flags = parseFlags(args);
  rejectUnknownFlags(flags, CONFIG_ALLOWED, "config");
  return {
    command: "config",
    json: flags.json === "" || flags.json === "true" || args.includes("--json"),  // tolerate `--json` without value
    cli: {
      dataDir: flags["data-dir"],
      port: flags.port ? parseInt(flags.port, 10) : undefined,
      chrome: flags.chrome,
      target: flags.target,
      models: parseModelFlagArray(flags.model),
    },
  };
}
```

Update the usage string to include `config   Print effective configuration`.

Note on `--json`: `parseFlags` expects `--flag value` pairs, so `--json` alone might need special handling. Check if `parseFlags` tolerates bareword flags — if not, use `--json=true` or add an "is a bareword boolean flag" escape hatch. Simplest: keep the current `parseFlags` behavior and have users write `--json true`. Document accordingly. (Or, if time permits, make `parseFlags` tolerate bareword booleans — that's a clean-up but out of scope for this task.)

- [ ] **Step 2:** Create `src/cli/config-command.ts`:

```ts
import type { ConfigArgs } from "./args";
import { loadConfig, type AppConfig } from "../config";

interface ConfigOutput {
  gauntlet: {
    dataDir: string;
    port: number;
    defaultChrome: { host: string; port: number };
    models: {
      agent: string;
      fanout: string | null;
      available: string[];
    };
    apiKeys: { anthropic: "set" | "unset"; openai: "set" | "unset" };
    sources: Record<string, string>;
  };
  sdkEnv: {
    ANTHROPIC_API_KEY: "set" | "unset";
    ANTHROPIC_BASE_URL: string | null;
    ANTHROPIC_LOG: string | null;
    OPENAI_API_KEY: "set" | "unset";
    OPENAI_BASE_URL: string | null;
    OPENAI_ORG_ID: string | null;
    OPENAI_PROJECT: string | null;
    HTTPS_PROXY: string | null;
    HTTP_PROXY: string | null;
    NO_PROXY: string | null;
  };
}

export function buildConfigOutput(config: AppConfig, env: NodeJS.ProcessEnv): ConfigOutput {
  return {
    gauntlet: {
      dataDir: config.dataDir,
      port: config.port,
      defaultChrome: config.defaultChrome,
      models: {
        agent: config.models.agent,
        fanout: config.models.fanout ?? null,
        available: config.models.available,
      },
      apiKeys: {
        anthropic: config.apiKeys.anthropic ? "set" : "unset",
        openai: config.apiKeys.openai ? "set" : "unset",
      },
      sources: config.sources,
    },
    sdkEnv: {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ? "set" : "unset",
      ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL ?? null,
      ANTHROPIC_LOG: env.ANTHROPIC_LOG ?? null,
      OPENAI_API_KEY: env.OPENAI_API_KEY ? "set" : "unset",
      OPENAI_BASE_URL: env.OPENAI_BASE_URL ?? null,
      OPENAI_ORG_ID: env.OPENAI_ORG_ID ?? null,
      OPENAI_PROJECT: env.OPENAI_PROJECT ?? null,
      HTTPS_PROXY: env.HTTPS_PROXY ?? null,
      HTTP_PROXY: env.HTTP_PROXY ?? null,
      NO_PROXY: env.NO_PROXY ?? null,
    },
  };
}

export function formatConfigText(output: ConfigOutput): string {
  const lines: string[] = [];
  lines.push("# Gauntlet configuration");
  lines.push("");
  lines.push(`  dataDir:        ${output.gauntlet.dataDir}  (${output.gauntlet.sources.dataDir})`);
  lines.push(`  port:           ${output.gauntlet.port}  (${output.gauntlet.sources.port})`);
  lines.push(`  defaultChrome:  ${output.gauntlet.defaultChrome.host}:${output.gauntlet.defaultChrome.port}  (${output.gauntlet.sources.defaultChrome})`);
  lines.push(`  models.agent:   ${output.gauntlet.models.agent}  (${output.gauntlet.sources["models.agent"]})`);
  lines.push(`  models.fanout:  ${output.gauntlet.models.fanout ?? "(unset)"}  (${output.gauntlet.sources["models.fanout"]})`);
  lines.push(`  models.available: [${output.gauntlet.models.available.join(", ")}]  (${output.gauntlet.sources["models.available"]})`);
  lines.push("");
  lines.push("# API keys");
  lines.push(`  anthropic:      ${output.gauntlet.apiKeys.anthropic}`);
  lines.push(`  openai:         ${output.gauntlet.apiKeys.openai}`);
  lines.push("");
  lines.push("# SDK-visible environment variables (pass through to SDKs, not read by Gauntlet)");
  for (const [k, v] of Object.entries(output.sdkEnv)) {
    lines.push(`  ${k.padEnd(22)}${v === null ? "(unset)" : v}`);
  }
  return lines.join("\n");
}

export function runConfigCommand(args: ConfigArgs, env: NodeJS.ProcessEnv): string {
  const config = loadConfig(args.cli, env);
  const output = buildConfigOutput(config, env);
  return args.json ? JSON.stringify(output, null, 2) : formatConfigText(output);
}
```

- [ ] **Step 3:** Wire it into `src/index.ts`:

```ts
case "config": {
  const { runConfigCommand } = await import("./cli/config-command");
  console.log(runConfigCommand(args, process.env));
  break;
}
```

- [ ] **Step 4: Write tests** `test/cli/config-command.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { buildConfigOutput, formatConfigText, runConfigCommand } from "../../src/cli/config-command";
import { loadConfig } from "../../src/config";
import type { ConfigArgs } from "../../src/cli/args";

const minimalArgs = (cli = {}): ConfigArgs => ({ command: "config", json: false, cli });

describe("runConfigCommand", () => {
  test("returns JSON when json flag true", () => {
    const result = runConfigCommand({ ...minimalArgs(), json: true }, {});
    const parsed = JSON.parse(result);
    expect(parsed.gauntlet.dataDir).toBe(".");
    expect(parsed.gauntlet.port).toBe(4400);
    expect(parsed.sdkEnv.ANTHROPIC_API_KEY).toBe("unset");
  });

  test("returns text format when json flag false", () => {
    const result = runConfigCommand(minimalArgs(), {});
    expect(result).toContain("# Gauntlet configuration");
    expect(result).toContain("dataDir:");
    expect(result).toContain("anthropic:");
  });

  test("text output shows source attribution", () => {
    const result = runConfigCommand(
      minimalArgs({ dataDir: "/flag" }),
      { GAUNTLET_PORT: "5500" } as NodeJS.ProcessEnv,
    );
    expect(result).toMatch(/dataDir:\s+\/flag\s+\(flag\)/);
    expect(result).toMatch(/port:\s+5500\s+\(env\)/);
  });

  test("sdkEnv section only shows presence for secrets", () => {
    const result = runConfigCommand({ ...minimalArgs(), json: true }, {
      ANTHROPIC_API_KEY: "sk-ant-secret",
      ANTHROPIC_BASE_URL: "https://custom",
    } as NodeJS.ProcessEnv);
    const parsed = JSON.parse(result);
    expect(parsed.sdkEnv.ANTHROPIC_API_KEY).toBe("set");
    expect(parsed.sdkEnv.ANTHROPIC_BASE_URL).toBe("https://custom");  // non-secret
  });
});
```

- [ ] **Step 5: Run tests — pass.**

- [ ] **Step 6: Smoke-test manually.**

```bash
bun run src/index.ts config
bun run src/index.ts config --json true
GAUNTLET_PORT=5500 bun run src/index.ts config --data-dir /tmp/x
```

- [ ] **Step 7: Commit.**

```
git add src/cli/args.ts src/cli/config-command.ts src/index.ts test/cli/config-command.test.ts
git commit -m "feat: add 'gauntlet config' subcommand with source attribution"
```

---

## Task 8: `GET /api/config/effective` route

**Files:**
- Create: `src/api/routes/config-effective.ts`
- Create: `test/api/config-effective.test.ts`
- Modify: `src/api/server.ts` — mount the new route

- [ ] **Step 1:** Create `src/api/routes/config-effective.ts`:

```ts
import { Hono } from "hono";
import type { AppConfig } from "../../config";
import { buildConfigOutput } from "../../cli/config-command";

export function configEffectiveRoutes(config: AppConfig) {
  const router = new Hono();

  router.get("/", (c) => {
    // Pass process.env at request time so it reflects current state.
    // (AppConfig fields come from the loaded config; the sdkEnv section
    // is a live read.)
    return c.json(buildConfigOutput(config, process.env));
  });

  return router;
}
```

- [ ] **Step 2:** Mount it in `createApp`:

```ts
api.route("/config/effective", configEffectiveRoutes(config));
```

Note: the existing `api.route("/config", configRoutes())` serves `/api/config` (UI model picker). The new route is `/api/config/effective` — a sibling, not a child. Hono nesting: register `configEffectiveRoutes` on `/config/effective` explicitly to keep the routes distinct. If Hono resolves parent-first, the `/config/effective` might shadow — test this. If it does, rename to `/config-effective` or `/effective-config`.

- [ ] **Step 3:** Write tests in `test/api/config-effective.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { configEffectiveRoutes } from "../../src/api/routes/config-effective";
import { loadConfig } from "../../src/config";

describe("GET /api/config/effective", () => {
  test("returns gauntlet + sdkEnv payload", async () => {
    const config = loadConfig({}, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
    const app = new Hono();
    app.route("/api/config/effective", configEffectiveRoutes(config));
    const res = await app.request("/api/config/effective");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gauntlet).toBeDefined();
    expect(body.sdkEnv).toBeDefined();
    expect(body.gauntlet.models.agent).toBe("claude-sonnet-4-6");
  });

  test("API keys reflect env at request time", async () => {
    const config = loadConfig({}, {} as NodeJS.ProcessEnv);
    const app = new Hono();
    app.route("/api/config/effective", configEffectiveRoutes(config));
    const saved = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      let body = await (await app.request("/api/config/effective")).json();
      expect(body.sdkEnv.ANTHROPIC_API_KEY).toBe("unset");

      process.env.ANTHROPIC_API_KEY = "sk-ant-xxx";
      body = await (await app.request("/api/config/effective")).json();
      expect(body.sdkEnv.ANTHROPIC_API_KEY).toBe("set");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
```

- [ ] **Step 4: Run tests — pass.**

- [ ] **Step 5: Run full suite + ui build.**

- [ ] **Step 6: Commit.**

```
git add src/api/routes/config-effective.ts src/api/server.ts test/api/config-effective.test.ts
git commit -m "feat: GET /api/config/effective for runtime config inspection"
```

---

## Task 9: Update `gauntlet run` CLI path to use `loadConfig`

**Files:**
- Modify: `src/index.ts` (run command dispatch)
- Modify: `src/api/routes/run.ts` (already done in Task 5 — this task handles the CLI run path)

The `gauntlet run` CLI currently constructs its own client + adapter + runAgent call inline. After Task 5, the route version does the right thing, but the CLI path still uses `parseModelFlags` + direct env var reads. Wire it to use `loadConfig`.

Find the CLI run dispatch (`case "run"` in `src/index.ts`). It currently looks something like:

```ts
case "run": {
  const { createClient } = await import("./models/resolve");
  const client = createClient(args.models.agent);
  // ... adapter construction, runAgent call ...
}
```

- [ ] **Step 1:** Rewrite the run case:

```ts
case "run": {
  const { loadConfig } = await import("./config");
  const { createClient } = await import("./models/resolve");
  const { runAgent } = await import("./agent/agent");
  const { EvidenceLogger } = await import("./evidence/logger");
  const { writeResultFiles } = await import("./evidence/writer");
  const { parseCard } = await import("./format/story-card"); // or wherever
  const { readFileSync } = await import("fs");
  const { join } = await import("path");

  const config = loadConfig(args.cli, process.env);

  if (!config.apiKeys.anthropic && !config.apiKeys.openai) {
    console.error("ERROR: No API key set. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
    process.exit(1);
  }

  const cardContent = readFileSync(args.scenarioPath, "utf8");
  const card = parseCard(cardContent, args.scenarioPath);

  const client = createClient(config.models.agent);
  const logger = new EvidenceLogger(args.outDir);

  let adapter;
  if (args.adapter === "web") {
    const { WebAdapter } = await import("./adapters/web/adapter");
    adapter = new WebAdapter({ chrome: config.defaultChrome });
  } else if (args.adapter === "cli") {
    const { CLIAdapter } = await import("./adapters/cli/adapter");
    adapter = new CLIAdapter();
  } else {
    const { TUIAdapter } = await import("./adapters/tui/adapter");
    adapter = new TUIAdapter();
  }

  try {
    await adapter.start(args.cli.target!);
    const result = await runAgent(card, adapter, client, logger, args.cli.target);
    writeResultFiles(args.outDir, result);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await adapter.close();
  }
  break;
}
```

The exact imports and flow should match whatever the existing `case "run"` uses — don't invent new helpers. The key changes: (1) call `loadConfig` instead of reading env directly; (2) pass `config.defaultChrome` (a `ChromeEndpoint` object) to `WebAdapter`; (3) use `config.models.agent` instead of `args.models.agent`.

Actually — `args.cli.target` is from the parsed args. If `RunArgs` no longer has `target` as a top-level field (it moved into `cli`), update the usage accordingly.

- [ ] **Step 2: Manually smoke-test** with a real card (Matt will do this as part of his E2E check). This task doesn't need new automated tests — the existing run-route tests in Task 5 cover the server path, and the CLI path is exercised by existing e2e tests.

- [ ] **Step 3: Run full test suite + ui build.**

- [ ] **Step 4: Commit.**

```
git add src/index.ts
git commit -m "refactor: gauntlet run CLI uses loadConfig for config resolution"
```

---

## Task 10: Documentation

**Files:**
- Modify: `README.md`
- Modify: `src/cli/args.ts` — expand usage string

- [ ] **Step 1:** Add a "Configuration" section to `README.md`. Include:
  - Precedence rule (`defaults < env < flags < per-request body`)
  - Table of flags for each command
  - Table of env vars (Gauntlet-prefixed only)
  - SDK env pass-through policy with a concrete "set `ANTHROPIC_BASE_URL` directly, Gauntlet doesn't wrap it" example
  - `gauntlet config` usage example with sample output
  - Docker/compose pattern: use `GAUNTLET_CHROME` for server-level default

- [ ] **Step 2:** Expand the `usage()` function in `src/cli/args.ts`:

```ts
function usage(): string {
  return `Usage: gauntlet <command> [options]

Commands:
  run <scenario.md>    Run a scenario
    --target <url>       (required) Application under test
    --model agent=<name> Model for the agent (default: claude-sonnet-4-6)
    --chrome host:port   Chrome debugging endpoint (default: 127.0.0.1:9222)
    --adapter <type>     web | cli | tui (default: web)
    --out <dir>          Evidence output directory (default: ./evidence)

  validate <scenario.md>  Validate a scenario file

  fanout <scenario.md>    Fan out scenario into sub-scenarios
    --out <dir>             Output directory
    --model fanout=<name>   Model for generation

  serve                    Start the API server
    --port <n>               Server port (default: 4400)
    --data-dir <dir>         Project root with stories/, results/
    --chrome host:port       Default Chrome endpoint for runs
    --target <url>           Default target (hint only; UI still overrides)
    --model agent=<name>     Default agent model

  config                   Print effective configuration
    --json true              Emit JSON instead of text
    (also accepts the same knobs as serve/run, for "what would happen if...")

Environment:
  GAUNTLET_PORT            Server port
  GAUNTLET_DATA_DIR        Project root
  GAUNTLET_CHROME          Default Chrome endpoint (host:port)
  GAUNTLET_AGENT_MODEL     Default agent model
  GAUNTLET_FANOUT_MODEL    Default fanout model
  GAUNTLET_MODELS          Comma-separated model allow-list

  ANTHROPIC_API_KEY        Read by the Anthropic SDK (if using Claude models)
  OPENAI_API_KEY           Read by the OpenAI SDK (if using GPT models)

Run 'gauntlet config' to see effective configuration at any time.`;
}
```

- [ ] **Step 3: Commit.**

```
git add README.md src/cli/args.ts
git commit -m "docs: add Configuration section and expand CLI usage string"
```

---

## Final verification

- [ ] `bun test` — all pass (the previously-failing `parseModelFlags > uses defaults when not specified` test should now be resolved by Task 4's test updates).
- [ ] `cd ui && bun run build` — no type errors.
- [ ] `bun run src/index.ts config` — prints formatted config, all sources show `default` for a fresh env.
- [ ] `GAUNTLET_PORT=5500 bun run src/index.ts config` — port shows `5500 (env)`.
- [ ] `bun run src/index.ts config --data-dir /tmp/x` — dataDir shows `/tmp/x (flag)`.
- [ ] `bun run src/index.ts config --json true` — valid JSON on stdout.
- [ ] `bun run src/index.ts serve --data-dir /tmp/gauntlet-e2e --port 14400`, then `curl http://localhost:14400/api/config/effective` — returns same payload as CLI.
- [ ] `bun run src/index.ts serve --bogus x` — fails with "Unknown flag" error, exits non-zero.
- [ ] Hand back to Matt for the full E2E test: real run, nav-away, refresh, pill restore — same checklist as the server-owned-runs session. Nothing in this refactor should break any of that, but it's the kind of thing that only shows up under real usage.
