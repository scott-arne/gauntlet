# Gauntlet run format

Each test run produces a self-contained directory on disk. This document
describes what's in it and how to read it.

## Directory layout

```
<projectRoot>/.gauntlet/results/<runId>/
  result.json        The run's result, including a manifest of evidence files
  result.md          Human-readable rendering of result.json
  run.jsonl          Append-only action log (one JSON object per tool call)
  screenshots/       Agent-captured screenshots
  frames/            Passive screencast frames
  issues/            Per-observation markdown (derived from observations)
```

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
  "schemaVersion": 1,
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
  }
}
```

### Fields

- `schemaVersion` — format version. `1` today.
- `runId` — composite id for this run. See [`runId`](#runid) above.
- `scenario` — id of the story card that was tested. Present alongside `runId`
  for convenience (the cardId is also embedded in `runId`, but having it as
  its own field is cheap and avoids string-parsing at read time).
- `status` — `"pass"`, `"fail"`, or `"investigate"`.
- `summary`, `reasoning` — the agent's write-up.
- `observations` — incidental findings, each with `kind` (`bug`, `ux`, `typo`,
  `suggestion`, `a11y`, `performance`) and `description`. An observation may
  also carry an `evidence` array of paths pointing at supporting files.
- `evidence` — pointers to files for this run:
  - `screenshots`: relative paths to screenshots
  - `log`: relative path to `run.jsonl`
  - `video` (optional): relative path to a video file, if the run produced one
- `duration_ms` — wall-clock time of the run.
- `usage` — token counts. `inputTokens` / `outputTokens` / `turns` are the
  primary signals. `cacheCreationInputTokens` and `cacheReadInputTokens`
  are Anthropic prompt-cache telemetry; they're optional and only populated
  when the provider reports them. A high `cacheReadInputTokens` relative
  to `inputTokens` means the cache is doing its job.

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

## Schema versioning

Bump `schemaVersion` only for incompatible changes to `result.json` or the
directory layout. Additive changes (new optional fields, new subdirectories)
do not require a bump.

### Changelog

- **v1** — Initial published format.
