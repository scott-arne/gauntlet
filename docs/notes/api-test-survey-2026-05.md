# `test/api/` ratio survey — Phase 7.1, PRI-1630

**Surveyor:** Surgeon@daef2708 · **Date:** 2026-05-18 · **Source state:** at `pri-1630-phase-6` (post-Task 6.2).

**Scope:** the three largest files in `test/api/` per the plan — `run.test.ts` (401 LOC), `fanout.test.ts` (392 LOC), `results.test.ts` (285 LOC). Total: 1078 LOC, 29 tests.

**Hypothesis under test:** the 4.21× test:source LOC ratio in `test/api/` is driven by redundant edge-case sprawl that can be collapsed via parameterization.

## File-by-file

### `test/api/run.test.ts` — 10 tests, 401 LOC

| Test | Assertion shape | Parameterizable? |
|---|---|---|
| `returns 404 for unknown scenario` | 404 + `error: "not found"` | no — singleton path |
| `returns 400 when target is missing` | 400 + error matches `target` | no — distinct error |
| `returns 400 when body includes turns field` | 400 + error matches `turns` | no — distinct error |
| `returns JSON 400 for unknown model prefix` | 400 + JSON content-type + `error: "unknown_model"` + 4 specific prefix strings in message + registry empty | no — distinct response shape (the message-content assertions are surface-specific) |
| `returns 202 with uniform shape and registers by runId` | 202 + body shape (runSetId/passes/runs[].runId regex) + registry has runId + abortController defined | no — happy-path lifecycle |
| `executeRun unregisters before broadcasting terminal event` | unregister happens before broadcast, captured via stub WS | no — singular ordering invariant |
| `body chrome override wins over server default` | mergeRunConfig result + 202 | no — singleton override-threading check |
| `returns 400 when model is not in allow-list` | 400 + error matches `allow-list` | no — distinct error |
| `rejects unknown adapter value with 400` | 400 + error matches `adapter` + `web` | no — distinct error |
| `screencast gate: saveScreencast=false does NOT create frames/` | helper(`false`) → `existsSync(framesDir)` is false | **YES** — pair with next |
| `screencast gate: saveScreencast=true creates frames/` | helper(`true`) → `existsSync(framesDir)` is true | **YES** — pair with prev |

Parameterizable: only the screencast-gate pair (2 tests → 1 `test.each`). Every other test has either a distinct error message, a distinct response shape, or a distinct invariant being checked.

### `test/api/fanout.test.ts` — 9 tests, 392 LOC

| Test | Assertion shape | Parameterizable? |
|---|---|---|
| `POST /api/fanout/:id returns 404 for unknown scenario` | 404 + error | no |
| `POST /api/fanout/:id returns 400 when fanout model not in allow-list` | 400 + error | no — distinct error |
| `POST /api/fanout/:id generates cards and writes to stories dir` | full fanout happy path (~100 LOC test) | no — singleton happy path |
| `POST /api/fanout/:id/observations promotes observations to story cards` | observations-promotion happy path | no |
| `POST /api/fanout/:id/observations returns empty generated when no observations` | empty path | no |
| `POST /api/fanout/:id/observations returns 404 when no result exists` | 404 | no |
| `POST /api/fanout/:id/:mode returns 404 for unknown mode` | 404 + distinct error | no |
| `POST /api/fanout/:id/failure generates follow-up stories from a failed run` | follow-up happy path | no |
| `POST /api/fanout/:id/failure returns 400 when result is not a failure` | 400 + distinct error | no |

No parameterization candidates. Three different sub-endpoints (`/`, `/observations`, `/failure`) each with happy-path + error path tests; collapsing across endpoints would conflate distinct contracts.

### `test/api/results.test.ts` — 10 tests, 285 LOC

| Test | Assertion shape | Parameterizable? |
|---|---|---|
| `GET /api/results returns first page and total` | list shape + pagination | no |
| `GET /api/results?cardId=<id> filters` | filtered list | no |
| `GET /api/results honors limit and offset` | pagination math | no |
| `GET /api/results clamps absurd limit to MAX_LIMIT` | clamp behavior | no |
| `GET /api/results/:runId returns a specific result` | single-fetch happy | no |
| `GET /api/results/:runId returns 404 for missing` | 404 | no |
| `GET /api/results handles malformed result.json gracefully` | list endpoint malformed handling | no — distinct endpoint |
| `GET /api/results/:runId returns 500 for malformed result.json` | single endpoint malformed → 500 | no — distinct endpoint |
| `GET /api/results/:runId rejects path traversal` | 400/security | no |
| `GET /api/results/:runId/file/:path serves files from a live run` | file-serving live | no |
| `GET /api/results/:runId/file/:path still enforces manifest on completed runs` | file-serving completed | no |
| `GET /api/results returns empty page when no results dir` | empty case | no |

No parameterization candidates. The list and single-result endpoints have parallel test pairs (404 / malformed / etc.), but each pair has distinct response shapes (list returns paginated array with totals; single-fetch returns the item or a 404/500). Merging across endpoints would lose the contract distinction.

## Bottom-line judgment

**No consolidation candidates worth landing.**

The only clean parameterization candidate across all three files is the 2-test screencast-gate pair in `run.test.ts:390-400`. They share a helper that already takes the boolean as a parameter, and `test.each([false, true])` would collapse them into one. The mechanical change is small.

But:
- The −1 test count is trivial.
- The two test names (`does NOT create` vs `creates`) state the contract direction explicitly. A merged test would have to name both directions in one title (cluttered) or lose that signal.
- The audit's premise (the 4.21× ratio implies sprawl) does not hold up under examination. Route handlers in `src/api/` are integration boundaries with wide input surfaces (request body shape, model allow-list, adapter type, query params, path traversal, malformed disk state, etc.). Each test in the three files pins a distinct contract or input combination.

**Recommendation: defer item #10.** Tag `pri-1630-phase-7` with no consolidation commits. The audit's hypothesis was reasonable to surface, and the survey result is "no — ratio is justified," which is one of the valid outcomes the plan anticipates.

If Susan still wants to take the screencast-gate pair as a token consolidation, fine — it's mechanical and harmless. But it's not worth a phase commit on its own.

This is a hard gate. The executor will not modify any test file without Susan's explicit candidate list.
