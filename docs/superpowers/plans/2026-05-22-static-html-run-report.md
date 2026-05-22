# Static HTML Run Report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `gauntlet run` writes a self-contained `<runDir>/index.html` showing the same view `gauntlet serve` does (status + summary + observations + evidence + transcript). A `gauntlet render <run-id>` command re-renders existing runs for styling iteration.

**Architecture:** A second Vite build target inlines the React app into one HTML template. A runtime renderer splices each run's `result.json` + `run.jsonl` into the template's `<script id="__GAUNTLET_RUN__">` data block. The React app gains a tiny static-mode branch in `useTranscript` and a new `StaticRunPage` that composes existing `RunDetail` + `TranscriptView` for the static surface. Same React components serve both `gauntlet serve` and the static file — one source of truth for styling.

**Tech Stack:** Bun, TypeScript, Hono (existing server, untouched), React 19 + Vite 6 (existing UI), `vite-plugin-singlefile` (new), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-05-22-static-html-run-report-design.md`
**Ticket:** PRI-1785

---

## File map

**Create:**
- `src/render/render-run.ts` — runtime renderer (`renderRun`, `renderRunFromTemplate`)
- `src/cli/render.ts` — `gauntlet render` subcommand
- `ui/src/static.tsx` — static entry point (mounts `StaticRunPage`)
- `ui/src/components/StaticRunPage.tsx` — composes `RunDetail` + `TranscriptView` from `window.__GAUNTLET_RUN__`
- `ui/vite.static.config.ts` — second Vite config for single-file build
- `test/render/render-run.test.ts` — renderer unit tests
- `test/cli/render-args.test.ts` — args-parser tests
- `test/paths.test.ts` — extend with `resolveRunDir` tests (file already exists)

**Modify:**
- `src/paths.ts` — add `resolveRunDir(projectRoot, stateDirName, runId)`
- `src/cli/args.ts` — add `RenderArgs` interface + `parseRenderArgs`
- `src/index.ts` — add `case "render"` dispatch
- `src/cli/run.ts` — auto-emit `index.html` after `runOne()` (best-effort)
- `ui/src/hooks/useTranscript.ts` — static-mode branch reading `window.__GAUNTLET_RUN__`
- `ui/src/lib/api.ts` — add `WindowWithGauntletRun` type augmentation
- `ui/package.json` — add `vite-plugin-singlefile`, add `build:static` script
- `package.json` — extend `build:ui` to also produce the static template

---

## Test fixtures

The renderer tests need a minimal run dir. Each test that needs one builds it fresh in a `Bun.tmpdir()` directory with synthesized `result.json` + `run.jsonl` (a few lines each) — no need to commit real fixture data.

---

## Task 1: Add `vite-plugin-singlefile` dependency

**Files:**
- Modify: `ui/package.json`

- [ ] **Step 1: Add the dependency**

```bash
cd ui && bun add -D vite-plugin-singlefile
```

Expected: `vite-plugin-singlefile` appears in `ui/package.json` `devDependencies`.

- [ ] **Step 2: Verify the package resolves**

```bash
cd ui && bun pm ls | grep vite-plugin-singlefile
```

Expected: prints a line with `vite-plugin-singlefile@<version>`.

- [ ] **Step 3: Commit**

```bash
git add ui/package.json ui/bun.lock
git commit -m "feat(deps): add vite-plugin-singlefile for static HTML build (PRI-1785)"
```

---

## Task 2: `resolveRunDir` helper in `src/paths.ts`

**Files:**
- Modify: `src/paths.ts`
- Modify: `test/paths.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/paths.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { resolveRunDir } from "../src/paths";

describe("resolveRunDir", () => {
  test("composes results-root + runId", () => {
    const path = resolveRunDir("/proj", ".gauntlet", "01-add-one_20260514T220510Z_u116");
    expect(path).toBe("/proj/.gauntlet/results/01-add-one_20260514T220510Z_u116");
  });

  test("honours a custom state-dir name", () => {
    const path = resolveRunDir("/proj", ".my-state", "card_2026T000000Z_aaaa");
    expect(path).toBe("/proj/.my-state/results/card_2026T000000Z_aaaa");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
bun test test/paths.test.ts
```

Expected: failures referencing `resolveRunDir` not exported.

- [ ] **Step 3: Implement `resolveRunDir`**

Add to `src/paths.ts` (after the existing `gauntletPath` function):

```typescript
/**
 * Absolute path to a run's results directory: `<stateDir>/results/<runId>`.
 * The run-id is itself a directory name (`<cardId>_<ts>_<nonce>`).
 */
export function resolveRunDir(projectRoot: string, stateDirName: string, runId: string): string {
  return gauntletPath(projectRoot, stateDirName, "results", runId);
}
```

- [ ] **Step 4: Run tests to verify passing**

```bash
bun test test/paths.test.ts
```

Expected: all `resolveRunDir` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts test/paths.test.ts
git commit -m "feat(paths): add resolveRunDir helper (PRI-1785)"
```

---

## Task 3: `RenderArgs` interface and parser

**Files:**
- Modify: `src/cli/args.ts`
- Create: `test/cli/render-args.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/cli/render-args.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { parseArgs } from "../../src/cli/args";

describe("parseArgs render", () => {
  test("parses a run-id positional", () => {
    const parsed = parseArgs(["render", "01-add-one_20260514T220510Z_u116"]);
    expect(parsed.command).toBe("render");
    if (parsed.command !== "render") throw new Error("unreachable");
    expect(parsed.runIdOrPath).toBe("01-add-one_20260514T220510Z_u116");
  });

  test("accepts --state-dir and --project-dir flags", () => {
    const parsed = parseArgs([
      "render",
      "/abs/path/to/run-dir",
      "--state-dir", ".my-state",
      "--project-dir", "/proj",
    ]);
    if (parsed.command !== "render") throw new Error("unreachable");
    expect(parsed.runIdOrPath).toBe("/abs/path/to/run-dir");
    expect(parsed.cli.stateDirName).toBe(".my-state");
    expect(parsed.cli.projectRoot).toBe("/proj");
  });

  test("rejects unknown flags", () => {
    expect(() => parseArgs(["render", "some-id", "--unknown", "x"]))
      .toThrow(/unknown flag/i);
  });

  test("missing positional throws usage error", () => {
    expect(() => parseArgs(["render"])).toThrow(/usage/i);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
bun test test/cli/render-args.test.ts
```

Expected: failures referencing `render` command not recognised.

- [ ] **Step 3: Implement the parser**

In `src/cli/args.ts`, near the other command interfaces add:

```typescript
export interface RenderArgs {
  command: "render";
  /** A run-id (looked up under <state-dir>/results/) or an absolute/relative path to a run dir. */
  runIdOrPath: string;
  cli: CliArgsInput;
}
```

Extend the parsed-args union type to include `RenderArgs` (alongside `RunArgs`, `ServeArgs`, etc.).

In the parser entry point (the function that switches on `args[0]`), add a `render` case that:
1. Extracts the first positional after `render`.
2. Throws `Error("Usage: gauntlet render <run-id-or-path>")` if missing.
3. Parses remaining flags against an allow-list of `["project-dir", "state-dir"]` (use the existing helpers — `parseFlags`, `rejectUnknownFlags` per the existing pattern; reuse exactly what `parseRunArgs` does for these two flags).
4. Returns `{ command: "render", runIdOrPath, cli: { projectRoot, stateDirName } }`.

(Read `parseRunArgs` in the same file as the model; mirror its flag-parsing block. Do not invent new helpers.)

- [ ] **Step 4: Run tests to verify passing**

```bash
bun test test/cli/render-args.test.ts
```

Expected: all four tests PASS. Also run the existing args tests to ensure no regression:

```bash
bun test test/cli
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts test/cli/render-args.test.ts
git commit -m "feat(cli): RenderArgs + parseArgs render subcommand (PRI-1785)"
```

---

## Task 4: Static-mode branch in `useTranscript`

**Files:**
- Modify: `ui/src/hooks/useTranscript.ts`
- Modify: `ui/src/lib/api.ts` (type augmentation)
- Create: `test/ui/use-transcript-static.test.ts`

- [ ] **Step 1: Declare the global shape**

Add to `ui/src/lib/api.ts` (near the top, after imports):

```typescript
/**
 * Static-mode payload injected at HTML build time. When present, the UI is
 * rendering a self-contained run report (no server). Hooks that would
 * normally fetch should read from this object instead.
 */
export interface StaticRunPayload {
  result: VetResult;
  runJsonl: string;
}

declare global {
  interface Window {
    __GAUNTLET_RUN__?: StaticRunPayload;
  }
}
```

(Place the `declare global` block in `api.ts` and rely on its import-side-effect for the rest of the app — there is precedent for this pattern in single-codebase projects.)

- [ ] **Step 2: Write the failing test**

Create `test/ui/use-transcript-static.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { useTranscript } from "../../ui/src/hooks/useTranscript";

const FIXTURE_JSONL = [
  JSON.stringify({ eventId: "e1", ts: "2026-05-22T00:00:00Z", type: "run_start", runId: "r1" }),
  JSON.stringify({ eventId: "e2", parentEventId: "e1", ts: "2026-05-22T00:00:01Z", type: "system_prompt", content: "hello" }),
].join("\n");

afterEach(() => {
  delete (globalThis as any).window?.__GAUNTLET_RUN__;
});

describe("useTranscript static mode", () => {
  test("reads from window.__GAUNTLET_RUN__ when present and skips fetch", async () => {
    (globalThis as any).window = (globalThis as any).window ?? globalThis;
    (window as any).__GAUNTLET_RUN__ = { result: { runId: "r1" }, runJsonl: FIXTURE_JSONL };

    const { result } = renderHook(() => useTranscript("r1"));
    await waitFor(() => expect(result.current.model).not.toBeNull());

    expect(result.current.error).toBeNull();
    expect(result.current.model?.events.length).toBeGreaterThan(0);
  });
});
```

> If `@testing-library/react` is not yet in `ui/package.json` devDependencies, install it as part of this step: `cd ui && bun add -D @testing-library/react`.

- [ ] **Step 3: Run test to verify failure**

```bash
bun test test/ui/use-transcript-static.test.ts
```

Expected: failure — the hook does not yet check `window.__GAUNTLET_RUN__`.

- [ ] **Step 4: Add the static-mode branch**

In `ui/src/hooks/useTranscript.ts`, immediately inside the effect (around line 30, before the existing `api.results.fileText(...)` call), add:

```typescript
const staticPayload = typeof window !== "undefined" ? window.__GAUNTLET_RUN__ : undefined;
if (staticPayload?.runJsonl) {
  try {
    const events = parseJsonl(staticPayload.runJsonl);
    if (!cancelled) setModel(reduceTranscript(events));
  } catch {
    if (!cancelled) setError("parse");
  }
  return;
}
```

(The rest of the existing fetch path stays unchanged below this block.)

- [ ] **Step 5: Run test to verify passing**

```bash
bun test test/ui/use-transcript-static.test.ts
```

Expected: PASS. Run the broader UI test suite to confirm no regression:

```bash
bun test test/ui
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/hooks/useTranscript.ts ui/src/lib/api.ts ui/package.json ui/bun.lock test/ui/use-transcript-static.test.ts
git commit -m "feat(ui): useTranscript static mode via window.__GAUNTLET_RUN__ (PRI-1785)"
```

---

## Task 5: `StaticRunPage` component

**Files:**
- Create: `ui/src/components/StaticRunPage.tsx`
- Create: `test/ui/static-run-page.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `test/ui/static-run-page.test.tsx`:

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StaticRunPage } from "../../ui/src/components/StaticRunPage";

const FIXTURE_RESULT = {
  schemaVersion: 5,
  runId: "01-card_20260522T000000Z_aaaa",
  scenario: "01-card",
  status: "pass" as const,
  summary: "All good",
  reasoning: "It worked",
  observations: [],
  evidence: { screenshots: [], log: "run.jsonl" },
  duration_ms: 123,
};

afterEach(() => { delete (window as any).__GAUNTLET_RUN__; });

describe("StaticRunPage", () => {
  test("renders status and summary from window.__GAUNTLET_RUN__", () => {
    (window as any).__GAUNTLET_RUN__ = { result: FIXTURE_RESULT, runJsonl: "" };
    render(<MemoryRouter><StaticRunPage /></MemoryRouter>);
    expect(screen.getByText(/All good/i)).toBeDefined();
    expect(screen.getByText(/pass/i)).toBeDefined();
  });

  test("renders an error if window.__GAUNTLET_RUN__ is missing", () => {
    render(<MemoryRouter><StaticRunPage /></MemoryRouter>);
    expect(screen.getByText(/no run data/i)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
bun test test/ui/static-run-page.test.tsx
```

Expected: failure — file does not exist.

- [ ] **Step 3: Create `StaticRunPage`**

`ui/src/components/StaticRunPage.tsx`:

```typescript
import { RunDetail } from "./RunDetail";
import { TranscriptView } from "./transcript";

/**
 * Top-level component for the static (file-based) HTML run report. Reads
 * the run data from `window.__GAUNTLET_RUN__`, then composes the same
 * `RunDetail` and `TranscriptView` components the server view uses.
 *
 * The transcript pulls its data from `window.__GAUNTLET_RUN__` via the
 * static-mode branch in `useTranscript`.
 */
export function StaticRunPage() {
  const payload = typeof window !== "undefined" ? window.__GAUNTLET_RUN__ : undefined;
  if (!payload) {
    return <div className="p-6 text-slate">No run data found. (window.__GAUNTLET_RUN__ is missing.)</div>;
  }
  const noop = () => {};
  return (
    <div className="static-run-report">
      <RunDetail result={payload.result} onFanout={noop} onRunAgain={noop} />
      <hr className="my-6 border-slate-300" />
      <section className="px-6 pb-6">
        <h2 className="text-lg font-semibold mb-2">Transcript</h2>
        <TranscriptView mode="posthoc" />
      </section>
    </div>
  );
}
```

> NOTE: If `RunDetail` or `TranscriptView` require contextual props (router params, callbacks) that the noop pattern can't satisfy, the implementer should read those components first and adjust. The shape above is the target; small adaptations to satisfy types are expected and acceptable. `TranscriptView mode="posthoc"` currently reads the `runId` from the URL via `useParams` — verify and, if needed, accept an optional `runId` prop in `TranscriptView` that defaults to the param. That refactor lives in this task if required.

- [ ] **Step 4: Run test to verify passing**

```bash
bun test test/ui/static-run-page.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/StaticRunPage.tsx test/ui/static-run-page.test.tsx
git commit -m "feat(ui): StaticRunPage composes RunDetail + TranscriptView from window payload (PRI-1785)"
```

---

## Task 6: Static entry point + Vite config + build script

**Files:**
- Create: `ui/src/static.tsx`
- Create: `ui/vite.static.config.ts`
- Modify: `ui/package.json` (add `build:static` script)
- Modify: `package.json` (extend `build:ui`)

- [ ] **Step 1: Create the static entry point**

`ui/src/static.tsx`:

```typescript
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import { StaticRunPage } from "./components/StaticRunPage";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <StaticRunPage />
      </BrowserRouter>
    </StrictMode>
  );
}
```

(BrowserRouter is included only because nested components may use `useParams`; it costs nothing for a single static page. If `StaticRunPage` and its children don't need a router after Task 5, omit it.)

- [ ] **Step 2: Create the static Vite config**

`ui/vite.static.config.ts`:

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    outDir: "dist-static",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "static.html"),
    },
  },
});
```

- [ ] **Step 3: Create the static HTML entry template**

`ui/static.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Gauntlet run report</title>
    <script type="application/json" id="__GAUNTLET_RUN__">{}</script>
    <script>
      // Hydrate window.__GAUNTLET_RUN__ from the inline JSON above. The
      // runtime renderer replaces the JSON contents per run; this glue
      // is build-time-stable.
      try {
        const node = document.getElementById("__GAUNTLET_RUN__");
        if (node && node.textContent && node.textContent.trim() !== "{}") {
          window.__GAUNTLET_RUN__ = JSON.parse(node.textContent);
        }
      } catch (e) { console.error("Failed to parse __GAUNTLET_RUN__", e); }
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/static.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Add the `build:static` script**

In `ui/package.json` `scripts`, add:

```json
"build:static": "vite build --config vite.static.config.ts"
```

- [ ] **Step 5: Extend root `build:ui` to also build the static template**

In `package.json` `scripts`, change `build:ui` from:

```json
"build:ui": "cd ui && bun run build"
```

to:

```json
"build:ui": "cd ui && bun run build && bun run build:static"
```

- [ ] **Step 6: Run the build and verify output**

```bash
bun run build:ui
```

Expected: completes without errors, produces:
- `ui/dist/index.html` (existing server bundle — unchanged behaviour)
- `ui/dist-static/static.html` (new — single-file inlined HTML with the placeholder script tag)

Verify the placeholder is present:

```bash
grep -c '__GAUNTLET_RUN__' ui/dist-static/static.html
```

Expected: at least `1`.

- [ ] **Step 7: Commit**

```bash
git add ui/src/static.tsx ui/vite.static.config.ts ui/static.html ui/package.json package.json
git commit -m "feat(build): single-file static HTML build target (PRI-1785)"
```

---

## Task 7: `renderRun` runtime function

**Files:**
- Create: `src/render/render-run.ts`
- Create: `test/render/render-run.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/render/render-run.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRunFromTemplate } from "../../src/render/render-run";

function makeFixtureRun(): { runDir: string; templatePath: string } {
  const base = mkdtempSync(join(tmpdir(), "gauntlet-render-"));
  const runDir = join(base, "run-1");
  mkdirSync(runDir);
  writeFileSync(join(runDir, "result.json"), JSON.stringify({
    schemaVersion: 5,
    runId: "card_2026T000000Z_aaaa",
    scenario: "card",
    status: "pass",
    summary: "ok",
    reasoning: "r",
    observations: [],
    evidence: { screenshots: [], log: "run.jsonl" },
    duration_ms: 1,
  }));
  writeFileSync(join(runDir, "run.jsonl"),
    JSON.stringify({ eventId: "e1", ts: "2026-05-22T00:00:00Z", type: "run_start" }) + "\n");
  const templatePath = join(base, "template.html");
  writeFileSync(templatePath,
    `<!doctype html><html><head><script type="application/json" id="__GAUNTLET_RUN__">{}</script></head><body></body></html>`);
  return { runDir, templatePath };
}

describe("renderRunFromTemplate", () => {
  test("writes index.html with the data block populated", async () => {
    const { runDir, templatePath } = makeFixtureRun();
    const outPath = await renderRunFromTemplate({ runDir, templatePath });
    expect(outPath).toBe(join(runDir, "index.html"));
    expect(existsSync(outPath)).toBe(true);
    const html = readFileSync(outPath, "utf-8");
    expect(html).toContain('id="__GAUNTLET_RUN__"');
    expect(html).toContain('"runId":"card_2026T000000Z_aaaa"');
    expect(html).toContain('"status":"pass"');
    expect(html).toContain('"runJsonl"');
  });

  test("escapes </script> in run-data to prevent breaking out of the script tag", async () => {
    const { runDir, templatePath } = makeFixtureRun();
    writeFileSync(join(runDir, "run.jsonl"),
      JSON.stringify({ eventId: "e1", type: "user_message", content: "evil </script><script>alert(1)</script>" }) + "\n");
    const outPath = await renderRunFromTemplate({ runDir, templatePath });
    const html = readFileSync(outPath, "utf-8");
    // No raw closing-script tag should appear inside the data block.
    const dataBlockEnd = html.indexOf("</script>", html.indexOf('id="__GAUNTLET_RUN__"'));
    const dataBlockStart = html.indexOf('id="__GAUNTLET_RUN__"');
    const dataBlockText = html.slice(dataBlockStart, dataBlockEnd);
    expect(dataBlockText).not.toContain("</script>");
  });

  test("throws if result.json is missing", async () => {
    const { runDir, templatePath } = makeFixtureRun();
    const badRunDir = runDir + "-empty";
    mkdirSync(badRunDir);
    await expect(renderRunFromTemplate({ runDir: badRunDir, templatePath })).rejects.toThrow(/result\.json/);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
bun test test/render/render-run.test.ts
```

Expected: failure — module does not exist.

- [ ] **Step 3: Implement the renderer**

`src/render/render-run.ts`:

```typescript
import { readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface RenderRunOptions {
  /** Absolute path to the run dir (must contain result.json and run.jsonl). */
  runDir: string;
  /** Absolute path to the static HTML template. */
  templatePath: string;
  /** Override output filename. Defaults to `index.html`. */
  outputName?: string;
}

/**
 * Render a run's HTML report using a caller-supplied template. The renderer
 * reads `result.json` + `run.jsonl` from `runDir`, splices them into the
 * template's `<script id="__GAUNTLET_RUN__">…</script>` tag, and writes the
 * result to `<runDir>/<outputName>`.
 */
export async function renderRunFromTemplate(opts: RenderRunOptions): Promise<string> {
  const resultPath = join(opts.runDir, "result.json");
  const jsonlPath = join(opts.runDir, "run.jsonl");

  try { await access(resultPath); }
  catch { throw new Error(`renderRun: missing result.json at ${resultPath}`); }

  const [template, resultText, runJsonl] = await Promise.all([
    readFile(opts.templatePath, "utf-8"),
    readFile(resultPath, "utf-8"),
    readFile(jsonlPath, "utf-8").catch(() => ""),
  ]);

  const payload = { result: JSON.parse(resultText), runJsonl };
  const json = JSON.stringify(payload).replace(/<\/script/gi, "<\\/script");

  const re = /(<script\s+type="application\/json"\s+id="__GAUNTLET_RUN__">)([\s\S]*?)(<\/script>)/i;
  if (!re.test(template)) {
    throw new Error("renderRun: template is missing the __GAUNTLET_RUN__ script tag");
  }
  const rendered = template.replace(re, (_m, open, _body, close) => `${open}${json}${close}`);

  const outPath = join(opts.runDir, opts.outputName ?? "index.html");
  await writeFile(outPath, rendered);
  return outPath;
}

/**
 * Convenience wrapper: locate the bundled template (shipped at
 * `<repo>/ui/dist-static/static.html`) and render. Throws a clear error
 * if the template is missing — likely means `bun run build:ui` was not
 * run after install.
 */
export async function renderRun(runDir: string): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/render/render-run.ts → ../../ui/dist-static/static.html
  const templatePath = join(here, "..", "..", "ui", "dist-static", "static.html");
  try { await access(templatePath); }
  catch { throw new Error(`renderRun: static template not found at ${templatePath}. Did you run 'bun run build:ui'?`); }
  return renderRunFromTemplate({ runDir, templatePath });
}
```

- [ ] **Step 4: Run tests to verify passing**

```bash
bun test test/render/render-run.test.ts
```

Expected: all three tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/render-run.ts test/render/render-run.test.ts
git commit -m "feat(render): renderRun + renderRunFromTemplate (PRI-1785)"
```

---

## Task 8: `gauntlet render` CLI command

**Files:**
- Create: `src/cli/render.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement the subcommand**

`src/cli/render.ts`:

```typescript
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { RenderArgs } from "./args";
import type { AppConfig } from "../config";
import { resolveRunDir } from "../paths";
import { renderRun } from "../render/render-run";

export interface RenderDeps {
  log?: (message: string) => void;
}

/**
 * Implements `gauntlet render <run-id-or-path>`. If the positional resolves
 * to an existing directory, treat it as a run-dir path. Otherwise treat it
 * as a run-id and look it up under the configured state dir.
 */
export async function render(args: RenderArgs, config: AppConfig, deps: RenderDeps = {}): Promise<void> {
  const log = deps.log ?? ((m) => process.stderr.write(m + "\n"));
  const arg = args.runIdOrPath;

  let runDir: string;
  if ((isAbsolute(arg) || arg.includes("/")) && existsSync(arg) && statSync(arg).isDirectory()) {
    runDir = arg;
  } else {
    runDir = resolveRunDir(config.projectRoot, config.stateDirName, arg);
    if (!existsSync(runDir)) {
      throw new Error(`Run dir not found: ${runDir} (looked up from run-id '${arg}')`);
    }
  }

  const outPath = await renderRun(runDir);
  log(outPath);
}
```

- [ ] **Step 2: Dispatch from `src/index.ts`**

In `src/index.ts` switch statement, add a new case alongside `run` and `serve`:

```typescript
case "render": {
  const config = await loadConfigOrThrow(args.cli);
  const { render } = await import("./cli/render");
  await render(args, config);
  break;
}
```

(Use a dynamic import to keep the render code out of the hot CLI startup path — matches the existing pattern for other subcommands in the same switch.)

- [ ] **Step 3: End-to-end smoke**

Pick (or create) any existing run directory under `.gauntlet/results/`. From `examples/todo/`:

```bash
ls examples/todo/.gauntlet/results/ | head -3
```

If any exist, render one:

```bash
cd examples/todo && bun /Users/mw/Code/prime/gauntlet/src/index.ts render <some-run-id>
```

Expected: prints the path to `index.html`. Opening that file in a browser shows the run's status/summary/transcript.

If no run dirs exist locally, skip the smoke; the unit tests already cover the renderer.

- [ ] **Step 4: Commit**

```bash
git add src/cli/render.ts src/index.ts
git commit -m "feat(cli): gauntlet render <run-id-or-path> (PRI-1785)"
```

---

## Task 9: Auto-emit `index.html` from `gauntlet run`

**Files:**
- Modify: `src/cli/run.ts`

- [ ] **Step 1: Add the auto-emit call**

Read `src/cli/run.ts` around line 89 to confirm the `runOne()` call shape. Right after the single-pass `await runOne(...)` returns and before the stderr `runId` print at ~line 101, add:

```typescript
// Best-effort: render the static HTML report into the run dir.
// A render failure must not fail the run itself.
try {
  const { renderRun } = await import("../render/render-run");
  await renderRun(summary.outDir);
} catch (err) {
  process.stderr.write(
    `[render] failed to write index.html: ${err instanceof Error ? err.message : String(err)}\n`
  );
}
```

(`summary` here is the variable name returned by `runOne()`; adapt to the actual binding name used in the file. The destructured `outDir` is the run directory.)

- [ ] **Step 2: Manual smoke**

Run a single small story end-to-end:

```bash
cd examples/todo && bun /Users/mw/Code/prime/gauntlet/src/index.ts run <some-card>
```

Expected: at the end of the run, `<runDir>/index.html` exists. Open it; it shows the run's view.

If the template is missing (build not run), the warning `[render] failed to write index.html: ... Did you run 'bun run build:ui'?` should appear and the run itself should exit normally.

- [ ] **Step 3: Verify run still succeeds when renderer breaks**

Quickly test the failure path: temporarily rename `ui/dist-static/static.html` to `static.html.bak`, run any story, observe the warning and that the run's exit code is unaffected. Then rename back.

```bash
mv ui/dist-static/static.html ui/dist-static/static.html.bak
cd examples/todo && bun /Users/mw/Code/prime/gauntlet/src/index.ts run <some-card>; echo "exit=$?"
mv ui/dist-static/static.html.bak ui/dist-static/static.html
```

Expected: warning printed, `exit=0` (or whatever the run's normal status code would be — `0` for pass).

- [ ] **Step 4: Commit**

```bash
git add src/cli/run.ts
git commit -m "feat(run): auto-emit index.html into the run dir (PRI-1785)"
```

---

## Task 10: Full `bun run check` and merge prep

- [ ] **Step 1: Run the full check**

```bash
bun run check
```

Expected: typecheck (src), typecheck (ui), build:ui, and all tests pass.

- [ ] **Step 2: Inspect a fully-rendered HTML by hand**

Open the most recent `<runDir>/index.html` in a browser. Verify:
- Status badge appears (pass/fail).
- Summary text appears.
- Observations list appears if the run had any.
- Transcript renders, with events.
- Screenshots (if any) load via their relative paths.

If any of these don't render, debug the specific component before declaring complete.

- [ ] **Step 3: Final commit (if any small fixes)**

```bash
git status
# if anything outstanding:
git add -A && git commit -m "chore: tidy after end-to-end verification (PRI-1785)"
```

- [ ] **Step 4: Move PRI-1785 to In Review**

Per `primeradiant-ops:linear-ticket-lifecycle`, transition the ticket to **In Review** and write a reflective implementation comment covering: what went smoothly, what was tricky, confidence level, risks for reviewers.

- [ ] **Step 5: Wait for direction on merge**

Do not merge to main without confirmation. The user said "no PRs — merge to main directly" as the project rule, but the merge itself is the user's call to make.

---

## Notes for the implementer

- **Test names and shapes are the floor, not the ceiling.** Add more tests if you see uncovered behaviour while implementing. Don't strip tests that pass with less work — the test names describe required behaviour.
- **`vite-plugin-singlefile` version mismatch with Vite 6:** if installation balks, check its README for the right peer-dep range. There's an `inlineAssets` family of plugins and a couple of forks; `vite-plugin-singlefile` (richardtallent) is the canonical one. If it doesn't fit, the architecture survives swapping in `@oboard/vite-plugin-singlefile` or a manual rollup config — what matters is "one HTML file, everything inlined, one placeholder script tag."
- **`TranscriptView` and `useParams`:** Task 5 noted that `TranscriptView mode="posthoc"` may pull `runId` from the URL. The static page has no URL routing in any meaningful sense. If the test in Task 5 reveals this, the cleanest fix is to accept an optional `runId` prop on `TranscriptView` and pass `payload.result.runId` from `StaticRunPage`. This is a small, contained refactor — appropriate to include in Task 5 as it surfaces.
- **`bun run check`** is the gate. If it doesn't go green at Task 10, do not move the ticket.
