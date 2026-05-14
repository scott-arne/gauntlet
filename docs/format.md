# Gauntlet run format

Each test run produces a self-contained directory on disk. This document
describes what's in it and how to read it.

## Directory layout

```
<projectRoot>/.gauntlet/results/<runId>/
  inputs/            Hermetic snapshot of what the agent was given:
                       story.md — copy of .gauntlet/stories/<id>.md at run start
                       context/ — copy of .gauntlet/context/ at run start
                     Captured once, synchronously, before the agent starts.
                     Edits to the source files after that point do not
                     affect the run's view.
  result.json        The run's result, including a manifest of evidence files
  result.md          Human-readable rendering of result.json
  run.jsonl          Append-only event stream — one JSON object per event.
                     Events: run_start, system_prompt, tool_definitions,
                     user_message, llm_request, llm_response (text,
                     thinking blocks, tool calls, usage, raw assistant
                     message), tool_call, tool_result (text inline or
                     image/artifact relative paths; mediaType when image
                     is set), event (adapter/agent anomalies), run_error
                     (orchestrator-level failures), shutdown_signaled
                     (agent observed daemon shutdown signal — turn may
                     be 0 if abort was already set when the loop began),
                     run_end. Every event carries eventId + parentEventId,
                     forming a linear chain.
  artifacts/         Document-like tool outputs spilled from tool_result
                     rows (DOM dumps, full-page extracts, large JSON, etc.)
  screenshots/       Agent-captured screenshots
  captures/          TUI screen captures (one .ansi + .json pair per
                     read_screen call). TUI runs only.
  frames/            Passive screencast frames
  issues/            Per-observation markdown, named NNN-<kind>-<slug>.md
                     where NNN is the 1-based index zero-padded to 3,
                     kind is the observation kind, and slug is the first
                     40 chars of the description with non-alphanumerics
                     collapsed to hyphens.
  console.jsonl      Browser console.* messages (web adapter)
  exception.jsonl    Page exceptions (web adapter)
  log.jsonl          Console-API entries (web adapter, distinct from
                     console.jsonl in source channel)
  network-ws.jsonl   WebSocket frames observed on the page (web adapter)
```

The four `*.jsonl` browser-event files exist on disk but are not listed in `result.json`'s manifest. The HTTP file route only serves files that the manifest names; consumers reading off disk see them, consumers reading via the API do not.

The `tool_definitions` event captures the full set of tool schemas exposed to the agent (adapter tools plus `report_result`) so post-hoc consumers — e.g. `gauntlet ask` — can faithfully tell a revival model what was available during the original run. It is written once immediately after `system_prompt`.

The `tool_result` event optionally carries a `mediaType` string when `image` is set, recording the image's media type so revival can slot the bytes back into a provider-native image block without guessing.

`projectRoot` is the Gauntlet project directory (default: cwd). Gauntlet
owns the `.gauntlet/` subdirectory inside it. `runId` is the primary
identity for a run — see below.

Copying a run directory preserves the full record of the run.

## `runId`

A run's id is a composite string: `<cardId>_<YYYYMMDDTHHMMSSZ>_<nonce>`.

Example: `login-001_20260416T142301Z_k3xm`

Parts:

- **cardId** — the story card this run tested. First thing the reader sees.
- **ISO 8601 basic-format timestamp** — UTC, second precision, no colons or
  hyphens. Lex-sortable = chronologically sortable.
- **4-char base36 nonce** — disambiguates same-second collisions.

runIds are designed to be read by humans and by LLMs scanning the
results directory. `ls .gauntlet/results/` tells you which card each run
tested and when, without a lookup.

## `result.json`

`result.json` is the manifest for the run. It records the verdict, the
agent's reasoning, the observations, and pointers to the evidence files.

```json
{
  "schemaVersion": 5,
  "runId": "login-001_20260416T142301Z_k3xm",
  "scenario": "login-001",
  "status": "pass",
  "summary": "User can log in with valid credentials.",
  "reasoning": "Navigated to /login, entered credentials, landed on dashboard.",
  "observations": [
    { "kind": "ux", "description": "Password field has no show/hide toggle." }
  ],
  "evidence": {
    "screenshots": ["screenshots/001.png", "screenshots/002.png"],
    "log": "run.jsonl"
  },
  "duration_ms": 14203,
  "usage": {
    "inputTokens": 12500,
    "outputTokens": 840,
    "turns": 7,
    "cacheCreationInputTokens": 4200,
    "cacheReadInputTokens": 8300
  },
  "config": {
    "target": "https://app.local",
    "model": "claude-sonnet-4-6",
    "adapter": "web",
    "budgetMs": 300000,
    "viewport": { "width": 1440, "height": 900 }
  }
}
```

### Fields

- `schemaVersion` — format version. `5` today.
- `runId` — composite id for this run. See [`runId`](#runid) above.
- `scenario` — id of the story card that was tested. Present alongside `runId`
  for convenience (the cardId is also embedded in `runId`, but having it as
  its own field is cheap and avoids string-parsing at read time).
- `status` — `"pass"`, `"fail"`, `"investigate"`, or `"errored"`. The
  `"errored"` value means the run did not produce a self-determined
  verdict — today's only emitter is shutdown drain (PRI-1507), where the
  daemon interrupts an in-flight agent loop. See `error` below.
- `error` (optional) — set when `status === "errored"`. Object with
  `type` (string) and `message` (string). `type` is open-typed so
  additive new error categories don't require a schema bump; consumers
  MUST tolerate unknown `type` values and render generically. Today's
  only emitted type is `"shutdown_interrupted"`.
- `summary`, `reasoning` — the agent's write-up.
- `observations` — incidental findings, each with `kind` (`bug`, `ux`, `typo`,
  `suggestion`, `a11y`, `performance`) and `description`. An observation may
  also carry an `evidence` array of paths pointing at supporting files.
- `evidence` — pointers to files for this run:
  - `screenshots`: relative paths to screenshots
  - `log`: relative path to `run.jsonl`
  - `artifacts` (optional): relative paths to document-like tool outputs
    spilled from tool_result rows (DOM dumps, full-page extracts, etc.)
  - `video` (optional): relative path to a video file, if the run produced one
  - `captures` (optional, TUI runs only): relative paths to TUI screen
    captures. Each entry points at the raw `.ansi` file; the parsed `.json`
    twin lives at the same stem (e.g. `captures/003.ansi` + `captures/003.json`).
- `duration_ms` — wall-clock time of the run.
- `usage` — token counts. `inputTokens` / `outputTokens` / `turns` are the
  primary signals. `cacheCreationInputTokens` and `cacheReadInputTokens`
  are Anthropic prompt-cache telemetry; they're optional and only populated
  when the provider reports them. A high `cacheReadInputTokens` relative
  to `inputTokens` means the cache is doing its job.
- `config` (optional) — snapshot of the knobs the run was launched with.
  Fields: `target`, `model`, `adapter` (`"web"` \| `"cli"` \| `"tui"`),
  `chrome` (host:port; omitted when the adapter auto-launched Chrome),
  `budgetMs` (wall-clock budget the run was launched with, in ms),
  `viewport` (`{width, height}`; omitted for the `cli` adapter).
  Used by the UI to offer "Run again" without re-asking the user for
  parameters. Optional for back-compat with v1 results on disk.
- `runSet` (optional) — context for runs that were spawned as part of a
  set (a multi-pass single run, or a `gauntlet batch` invocation). Fields:
  `runSetId`, `kind` (`"single"` \| `"batch"`), `passes`, `cards` (array of
  cardIds in deterministic order), `cardIndex` (0-indexed position in
  `cards`), `attemptNumber` (1-indexed within the cards × attempts loop).
  Omitted for one-off `gauntlet run` invocations.

### Path references

Every path in `result.json` is a **relative path from the run directory**. To
find the file, join the path with the run root. That's the whole rule — no
subdir translation, no hidden mapping.

## HTTP access

The server exposes each run through endpoints under `/api/results`:

- `GET /api/results` — list runs. Supports query params `limit`, `offset`,
  and `cardId` for pagination and filtering. Returns
  `{ results: VetResult[], total, limit, offset }`.
- `GET /api/results/:runId` — one run's parsed `result.json`.
- `GET /api/results/:runId/file/:relativePath` — fetch a file inside a run
  directory. **The file must be listed in that run's `result.json`**;
  arbitrary files on disk are not accessible through the API. Path traversal
  outside the run directory is blocked.

A screenshot listed as `"screenshots/001.png"` in a run's manifest is served
by `GET /api/results/<runId>/file/screenshots/001.png`.

## WebSocket stream

Clients open a WebSocket at `/api/ws?run=<runId>`. The server emits several
message types; consumers may dispatch on `type` and ignore the rest.

- `transcriptSnapshot` — sent once on connect if `run.jsonl` exists on disk
  for the run. Shape: `{ type: "transcriptSnapshot", events: TranscriptEvent[] }`.
  Includes every event written so far. Consumed by the transcript view.
- `event` — broadcast for every new event written to `run.jsonl` during a
  live run. Shape: `{ type: "event", event: TranscriptEvent }`. Verbatim
  mirror of the jsonl line. Consumed by the transcript view.
- `snapshot` — legacy. Sent on connect for runs that are currently active.
  Shape: `{ type, lastFrame, progressLog }`. Consumed by the LiveRun view.
- `frame` — base64 JPEG screencast frame from the web adapter. Consumed by
  LiveRun.
- `progress` — stringified `[action] {...params}` lines (legacy observer
  channel, different from `event`). Consumed by LiveRun.
- `complete` — run finished; carries the full `VetResult` object.
- `error` — fatal run error; carries a message string.
- `gone` — the server has no active run for this id. Clients should fall
  back to the on-disk `result.json` + `run.jsonl` via the HTTP endpoints.

Events in `transcriptSnapshot` and subsequent `event` messages can overlap
in a narrow startup window. Clients dedupe by `eventId` (the reducer
treats any event with `eventId <= model.maxEventId` as a no-op).

## Schema versioning

Bump `schemaVersion` only for incompatible changes to `result.json` or the
directory layout. Additive changes (new optional fields, new subdirectories)
do not require a bump.

### Changelog

- **v5** — Added `"errored"` to `VetStatus` and optional `error: {type,
  message}` field on `VetResult`. Today's only emitter is shutdown drain
  (PRI-1507): when the daemon's shutdown grace window expires with runs
  in flight, an AbortSignal-driven cancellation fires through the agent
  loop, which returns a synthetic errored result with `error.type:
  "shutdown_interrupted"`. If even the post-abort patience window
  expires, the daemon writes a minimal stub `result.json` (no `usage`
  field; `duration_ms` derived from the registry's `startedAt`, or `-1`
  as a sentinel if absent). Also added `shutdown_signaled` named event
  to `run.jsonl`. `error.type` is open-typed (string) — additive new
  categories don't require a schema bump.
- **v4** — Removed `maxStuckRetries` from `config` (the stuck-handling
  system-prompt block it templated into has been retired in favor of
  mid-loop reflection checkpoints). Additive for readers; the field is
  simply absent on new runs.
- **v3** — `config.turns` (max-turn cap) replaced with `config.budgetMs`
  (wall-clock budget in ms) and `config.maxStuckRetries`. Reflects the
  time-budget loop replacing maxTurns. Readers expecting `turns` will
  not find it on v3+ runs.
- **v2** — Added optional `config` block to `result.json` capturing the
  per-run knobs (target, model, adapter, chrome, turns, viewport) so the
  UI can offer a "Run again" action without re-eliciting parameters.
  Additive; v1 readers ignore the field.
- **v1** — Initial published format.
