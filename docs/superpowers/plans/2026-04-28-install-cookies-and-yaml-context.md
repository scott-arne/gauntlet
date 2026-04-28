# `install_cookies` + credential YAML migration — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [docs/plans/2026-04-15-gauntlet-v1.5-spec.md](../../plans/2026-04-15-gauntlet-v1.5-spec.md) — §3.2 (install_passkey, now YAML) and §3.4 (install_cookies, new). Both are authoritative prose; the description strings in `passkey.ts`/`cookies.ts` must match the spec verbatim.

**Linear:** PRI-1403.

**Goal:** Add `install_cookies` tool to the web adapter and migrate `install_passkey`'s credential file format from JSON to YAML, so context credentials have one consistent format. Spec amendment for both is already merged on this branch (commit `docs(spec): v1.5 amendment`).

**Architecture:** New `src/adapters/web/cookies.ts` mirrors `src/adapters/web/passkey.ts`'s structure (registration predicate, build-tool factory, sanitized action log) with two key differences: no pinned CDP session and no teardown (cookies are browser-state, not session-state); per-cookie accept/reject aggregation via `Network.setCookie` (singular). Driver shape: `CookiesDriver.setCookies(tab, cookies) → Promise<SetCookieResult[]>`. The driver implementation in `chrome-ws-lib.js` issues one `Network.setCookie` per entry and aggregates. `WebAdapter` constructs `cookiesTool` next to `passkeyTool`, registers it in `toolDefinitions()`, dispatches in `executeTool()`. Passkey migration swaps `JSON.parse` → `YAML.parse` and updates the tool description string + parameter description to match the amended §3.2.

**Tech Stack:** TypeScript, Bun, `bun:test`. New dep: `yaml` (eemeli/yaml — actively maintained, native TS types, YAML 1.2). No CDP-library upgrade required — `chrome-ws-lib.js` already has `sendCdpCommand` and uses it for similar low-level operations.

---

## File structure

**New files:**
- `src/adapters/web/cookies.ts` — `buildInstallCookiesTool(contextRoot, tab, driver, logger?) → CookiesTool | null`. Exports types: `CookieParam`, `CookiesDriver`, `SetCookieResult`, `CookiesTool`, plus `readCookiesFile(absolutePath) → CookieParam[]` for testability.
- `test/adapters/web/cookies.test.ts` — mirrors passkey.test.ts: `readCookiesFile` parsing/validation, registration predicate, verbatim tool description, success path with sanitized log, partial-success aggregation, missing path, path-escape, read_cookies error, driver step failures.

**Modified files:**
- `package.json` — add `yaml` dep.
- `src/adapters/web/passkey.ts` — swap `JSON.parse` → `YAML.parse`; update `readPasskeyFile` error messages to surface YAML line/column on parse failure; update `TOOL_DESCRIPTION` and the parameter description to match amended §3.2 (JSON → YAML, `.json` → `.yaml`); update parameter `description` field.
- `src/adapters/web/adapter.ts` — add `cookiesDriver`, `cookiesTool` field; construct in constructor; register in `toolDefinitions()`; dispatch `install_cookies` in `executeTool()`.
- `src/adapters/web/lib/chrome-ws-lib.js` — add `setCookies(tab, cookies) → Promise<SetCookieResult[]>` helper; export it. Mirrors `clearCookies` shape; issues `Network.setCookie` per entry, returns `[{ name, success, errorReason? }]`.
- `test/adapters/web/passkey.test.ts` — switch fixture writes from `JSON.stringify(SAMPLE_PASSKEY)` to YAML; update verbatim description string assertion to match amended §3.2; update file names from `passkey.json` to `passkey.yaml`.
- `.gauntlet/context/matt/passkey.json` → `.gauntlet/context/matt/passkey.yaml` (rename + reformat). Convert the existing JSON contents to YAML by hand or by running `node -e "console.log(require('yaml').stringify(require('./.gauntlet/context/matt/passkey.json')))"` after `yaml` is installed.

---

## Tasks

### Task 1: Add `yaml` dependency

**Files:**
- Modify: `package.json` (and `bun.lock`)

**Goal:** YAML parser available in the project. No code changes use it yet.

- [ ] **Step 1:** Run `cd /Users/mw/Code/prime/gauntlet && bun add yaml` from the repo root. Confirm `yaml` appears in `package.json` `dependencies`.
- [ ] **Step 2:** Run `bun run typecheck` to confirm nothing broke from the install. Should be a no-op for the typecheck.
- [ ] **Step 3:** Commit: `chore: add yaml dep (PRI-1403)`. Sign-off matches the project convention (`Co-Authored-By: <BobName> (Bob <session-id-prefix>/Opus 4.7)`).

---

### Task 2: Migrate `passkey.ts` from JSON to YAML

**Files:**
- Modify: `src/adapters/web/passkey.ts`
- Modify: `test/adapters/web/passkey.test.ts`
- Rename + reformat: `.gauntlet/context/matt/passkey.json` → `.gauntlet/context/matt/passkey.yaml`

**Goal:** `install_passkey` reads YAML; tool description matches amended §3.2; existing test suite passes after fixture update.

- [ ] **Step 1: Update the failing tests first.** In `test/adapters/web/passkey.test.ts`:
  - Replace `JSON.stringify(SAMPLE_PASSKEY)` with `YAML.stringify(SAMPLE_PASSKEY)` (import `* as YAML from "yaml"` at the top).
  - Rename every `passkey.json` literal to `passkey.yaml`.
  - Update the `expected` description string in the "tool description matches spec §3.4 verbatim" test to match the amended §3.2 prose:

    ```
    Install a passkey credential into the browser's virtual authenticator,
    reading the credential YAML from a file under the project's context
    directory. The path is relative to .gauntlet/context/ (example:
    "alice/passkey.yaml"). You must re-call this tool after every navigate()
    and before any click that triggers WebAuthn — Chrome clears virtual
    authenticators on every same-target navigation, and the authenticator does
    not survive. Calls are safe and cheap to repeat. The tool returns a
    success message naming the rpId on success; on failure it returns an
    error identifying the CDP step that failed.
    ```

    (The only changes from the original: "credential JSON" → "credential YAML"; `"alice/passkey.json"` → `"alice/passkey.yaml"`.)
  - Update the test that writes a malformed file to use malformed YAML, e.g. `writeFileSync(filePath, ":\n  : :")` so the YAML parser raises. Update the `expect(() => readPasskeyFile(filePath)).toThrow(/invalid JSON/)` assertion to `toThrow(/invalid YAML/)`.

  Run `bun test test/adapters/web/passkey.test.ts` — should fail because `passkey.ts` still parses JSON.

- [ ] **Step 2: Update `passkey.ts` to use YAML.** In `src/adapters/web/passkey.ts`:
  - Import: `import * as YAML from "yaml";`
  - Replace `JSON.parse(raw)` with a `try { YAML.parse(raw) } catch (err) { throw new Error('passkey "...": invalid YAML (...) ') }` block. Surface the parser error message verbatim — `yaml`'s `YAMLParseError` includes `linePos` so the message is useful as-is.
  - Update `TOOL_DESCRIPTION` to swap "credential JSON" → "credential YAML" and `"alice/passkey.json"` → `"alice/passkey.yaml"`.
  - Update the `path` parameter `description` field to swap "passkey JSON file" → "passkey YAML file" and `'alice/passkey.json'` → `'alice/passkey.yaml'`.

  Run `bun test test/adapters/web/passkey.test.ts` — all tests should now pass.

- [ ] **Step 3: Migrate the on-disk fixture.** Convert `.gauntlet/context/matt/passkey.json` to `.gauntlet/context/matt/passkey.yaml`. The shape is unchanged — a simple key:value YAML map. Delete the original `.json` file. Verify by running `bun test` (full suite) — the adapter test that exercises the fixture path should still pass.

- [ ] **Step 4: Run `bun run typecheck && bun test`.** Both must pass before moving on.

- [ ] **Step 5:** Commit: `feat(web): install_passkey reads YAML credentials (PRI-1403)`.

---

### Task 3: `setCookies` driver in `chrome-ws-lib.js`

**Files:**
- Modify: `src/adapters/web/lib/chrome-ws-lib.js`

**Goal:** A low-level `setCookies(tab, cookies)` helper that issues `Network.setCookie` per entry and returns per-entry results. Mirrors `clearCookies`'s style.

- [ ] **Step 1:** Read the existing `clearCookies` definition (around line 3017) and the `module.exports` block (around line 3329) to understand the export pattern.

- [ ] **Step 2:** Add a `setCookies` function that:
  - Resolves the tab to a `wsUrl` the same way `clearCookies` does.
  - For each cookie object, calls `await sendCdpCommand(wsUrl, 'Network.setCookie', cookie)`.
  - Each `Network.setCookie` response has shape `{ success: boolean }`. CDP does not surface an `errorReason` field for `setCookie` failures, but the cookie object that fails will have `success: false`. To capture *why* it failed, wrap the call in try/catch — if `sendCdpCommand` throws, capture the thrown error message; otherwise, on `success: false`, set `errorReason` to `"chrome rejected cookie (no detail provided)"`.
  - Aggregate per-cookie results: `[{ name: cookie.name, success: boolean, errorReason?: string }]`.
  - Returns the array. Does not throw on partial failure — that's the *expected* shape the tool layer relies on.

- [ ] **Step 3:** Add `setCookies` to the `module.exports` object.

- [ ] **Step 4:** No unit test for the JS lib itself (it's exercised through the cookies tool's tests with a fake driver). Run `bun run typecheck` to confirm the import resolves cleanly when `cookies.ts` is added in Task 4.

- [ ] **Step 5:** Commit: `feat(web): chrome-ws-lib — Network.setCookie helper (PRI-1403)`.

---

### Task 4: Implement `cookies.ts` (TDD)

**Files:**
- Create: `src/adapters/web/cookies.ts`
- Create: `test/adapters/web/cookies.test.ts`

**Goal:** `buildInstallCookiesTool` returns a tool that the adapter can register and execute. No teardown method (cookies are browser-state). Per-cookie accept/reject aggregation in the tool result.

- [ ] **Step 1: Write the test file first.** Mirror `test/adapters/web/passkey.test.ts`'s structure. Cover:
  - `readCookiesFile`: parses valid YAML; throws on missing file; throws with line/column on malformed YAML; throws on missing required fields (`name`, `value`, origin info); throws on unknown fields like `samesite` (case-mismatch); accepts both `url` form and `domain`+`path` form.
  - Registration predicate: `buildInstallCookiesTool` returns `null` when context root is missing/empty/a-file, registers when context root is non-empty even without `cookies.yaml` files (matching the passkey pattern).
  - Tool definition: `name === "install_cookies"`, parameter `path` is required, description matches §3.4 verbatim.
  - Success path: `tool.execute({ path: "matt/cookies.yaml" })` — driver called once with the parsed cookie array; tool result contains "Installed N/M cookies" and lists accepted cookie names; `install_cookies_ok` action logged with sanitized context (counts, name list, valueLength only — no value bytes); JSON.stringify of the log entry must not contain any cookie value byte.
  - Partial success: driver returns mixed `success: true` / `success: false`; tool result calls out rejected cookies by name with reason; log includes a `rejected` count.
  - Missing path argument: returns `Error: ...` text, logs `install_cookies_failed` with `step: "validate_args"`.
  - Path escape (`../foo`) and absolute paths: rejected at `step: "resolve_path"`.
  - Non-existent file: surfaces as `step: "read_cookies"`.
  - Driver throws (e.g. CDP timeout): tool returns step-labeled error with `step: "set_cookies"`, logs `install_cookies_failed`.
  - No `teardown()` method on the returned `CookiesTool` interface — the test asserts that the returned object does not have a `teardown` field.

  Use the same fake-logger pattern as `passkey.test.ts` (`makeFakeLogger`).

  Run `bun test test/adapters/web/cookies.test.ts` — should fail (file doesn't exist yet).

- [ ] **Step 2: Implement `src/adapters/web/cookies.ts`.** Mirror passkey.ts's structure:
  - Imports: `readFileSync, readdirSync, statSync` from `fs`; `* as YAML from "yaml"`; `ToolDefinition, ToolResult` from `../../models/provider`; `EvidenceLogger` from `../../evidence/logger`; `resolveInside` from `../../paths`.
  - Type: `CookieParam` mirroring CDP's params (`name`, `value`, `url?`, `domain?`, `path?`, `secure?`, `httpOnly?`, `sameSite?`, `expires?`, `priority?`, `sameParty?`, `sourceScheme?`, `sourcePort?`).
  - Type: `SetCookieResult = { name: string; success: boolean; errorReason?: string }`.
  - Type: `CookiesDriver = { setCookies(tab: number, cookies: CookieParam[]): Promise<SetCookieResult[]> }`.
  - Type: `CookiesTool = { definition: ToolDefinition; execute(args): Promise<ToolResult> }` — no `teardown`.
  - `TOOL_DESCRIPTION` constant matching the §3.4 prose verbatim. (Multi-line string concatenation, same style as passkey.ts.)
  - `readCookiesFile(absolutePath): CookieParam[]` — reads, `YAML.parse`, validates each entry. Allowed fields: the CDP CookieParam keys above. Reject unknown fields with a clear "unknown field 'X' (did you mean 'Y'?)" message when there's a known close-match (only worry about the obvious `samesite`/`SameSite`/`Samesite` case — anything else gets the generic "unknown field" message).
  - `cookieContext(cookie)` sanitizer: returns `{ name, domain: cookie.domain ?? null, url: cookie.url ?? null, path: cookie.path ?? null, secure: !!cookie.secure, httpOnly: !!cookie.httpOnly, sameSite: cookie.sameSite ?? null, valueLength: cookie.value.length }`. **Never** include `value`.
  - `contextRootIsPopulated` helper — paste from passkey.ts (or factor out into `src/paths.ts` if the time pressure permits, else duplicate).
  - `buildInstallCookiesTool(contextRoot, tab, driver, logger?)`:
    - Returns null when `!contextRootIsPopulated(contextRoot)`.
    - Definition: `name: "install_cookies"`, parameters `{ path: { type: "string", description: "Path to the cookies YAML file, relative to .gauntlet/context/. Example: 'alice/cookies.yaml'." } }`, `required: ["path"]`.
    - Execute: validate args → resolveInside → readCookiesFile → driver.setCookies → aggregate accepted/rejected → return tool result text and log `install_cookies_ok` (or `install_cookies_failed` at the relevant step).
    - Result text format:
      - All accepted: `Installed N cookies (matt/cookies.yaml). Accepted: _session, _csrf.`
      - Partial: `Installed 2/3 cookies (matt/cookies.yaml). Accepted: _session, _csrf. Rejected: tracker (chrome rejected cookie (no detail provided)).`
      - All rejected: `Installed 0/N cookies. Rejected: ...`. Still returns success at the tool level (the agent learns *what* failed, then decides) — only true CDP-level failure (e.g. the call threw) surfaces as `Error: ...`.

  Run `bun test test/adapters/web/cookies.test.ts` — all tests should pass.

- [ ] **Step 3:** Run `bun run typecheck && bun test`. Both must pass.

- [ ] **Step 4:** Commit: `feat(web): install_cookies tool (PRI-1403)`.

---

### Task 5: Wire `install_cookies` into `WebAdapter`

**Files:**
- Modify: `src/adapters/web/adapter.ts`
- Possibly modify: `test/adapters/web/adapter.test.ts` (if the test asserts the tool list — search for `toolDefinitions` references in the test).

**Goal:** The web adapter constructs `cookiesTool` next to `passkeyTool`, registers it in `toolDefinitions()`, and dispatches `install_cookies` in `executeTool()`.

- [ ] **Step 1:** In `src/adapters/web/adapter.ts`:
  - Import `buildInstallCookiesTool, type CookiesTool, type CookiesDriver` from `./cookies`.
  - Constant `COOKIES_TAB = 0` next to `PASSKEY_TAB`.
  - Driver: `const cookiesDriver: CookiesDriver = { async setCookies(tab, cookies) { return await chrome.setCookies(tab, cookies); } };`. Place next to `webAuthnDriver`.
  - Field: `private cookiesTool: CookiesTool | null;`
  - Constructor: `this.cookiesTool = options?.contextRoot ? buildInstallCookiesTool(options.contextRoot, COOKIES_TAB, cookiesDriver, this.logger) : null;` — directly after the passkey construction.
  - `toolDefinitions()`: `if (this.cookiesTool) tools.push(this.cookiesTool.definition);` — directly after the passkey push.
  - `executeTool()`: `if (name === "install_cookies" && this.cookiesTool) return this.cookiesTool.execute(args);` — directly after the passkey dispatch.
  - **No teardown change.** `cookiesTool` has no teardown.

- [ ] **Step 2:** Search `test/adapters/web/adapter.test.ts` for `toolDefinitions` and `install_passkey`. If the existing tests assert tool names/counts, update them to include `install_cookies`. If not, no test changes needed at this level — `cookies.test.ts` covers the tool itself, and the adapter dispatch is mechanical.

- [ ] **Step 3:** Run `bun run typecheck && bun test`. Both must pass.

- [ ] **Step 4:** Commit: `feat(web): wire install_cookies into WebAdapter (PRI-1403)`.

---

### Task 6: Final verification

- [ ] **Step 1:** Run `bun run check` (typecheck + UI typecheck + UI build + test). All green.

- [ ] **Step 2:** Smoke-check the example `cookies.yaml` parses by writing a one-off:

  ```bash
  cd /Users/mw/Code/prime/gauntlet
  cat > /tmp/cookies-smoke.yaml <<EOF
  - name: _session
    value: smoketest
    domain: .example.test
    path: /
    secure: true
    httpOnly: true
    sameSite: Lax
  EOF
  bun -e "const {readCookiesFile} = await import('./src/adapters/web/cookies.ts'); console.log(readCookiesFile('/tmp/cookies-smoke.yaml'));"
  ```

  Confirm the output reflects the input verbatim and no warnings appear.

- [ ] **Step 3:** Verify the spec/tool prose alignment one more time. Run:

  ```
  grep -A 12 "TOOL_DESCRIPTION =" src/adapters/web/passkey.ts
  grep -A 12 "TOOL_DESCRIPTION =" src/adapters/web/cookies.ts
  ```

  Compare each block to the §3.2 / §3.4 prose in `docs/plans/2026-04-15-gauntlet-v1.5-spec.md`. Any drift, fix the code (the spec is authoritative).

- [ ] **Step 4:** Stop here. Do not move the Linear ticket or merge to main. Report back to the dispatching Bob with: branch name, list of commits, and any deviations from this plan.

---

## Out of scope (do not do)

- `clear_cookies` tool — out of scope per the ticket.
- Auto-renavigate after install — out of scope per the ticket.
- Importing cookies from a browser profile or `.har` — out of scope per the ticket.
- Refactoring `contextRootIsPopulated` into a shared helper — duplicating it in cookies.ts is fine for now; if the duplication ever bothers a future Bob they can factor it out then.
- Updating the system-prompt Context section prose to mention cookies — the spec's §4.1 prose ("some also contain `passkey.yaml` for WebAuthn sign-in via `install_passkey`") is intentionally narrow; an analogous mention of `cookies.yaml` is a future spec amendment, not part of this ticket.
