# Gauntlet run format

Each test run produces a self-contained directory on disk. This document
describes what's in it and how to read it.

## Directory layout

```
<data-dir>/results/<scenario>/
  result.json        The run's result, including a manifest of evidence files
  result.md          Human-readable rendering of result.json
  run.jsonl          Append-only action log (one JSON object per tool call)
  screenshots/       Agent-captured screenshots
  frames/            Passive screencast frames
  issues/            Per-observation markdown (derived from observations)
```

Copying a run directory preserves the full record of the run.

## `result.json`

`result.json` is the manifest for the run. It records the verdict, the
agent's reasoning, the observations, and pointers to the evidence files.

```json
{
  "schemaVersion": 1,
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
  "usage": { "inputTokens": 12500, "outputTokens": 840, "turns": 7 }
}
```

### Fields

- `schemaVersion` — format version. `1` today.
- `scenario` — id of the story card that was tested.
- `status` — `"pass"`, `"fail"`, or `"investigate"`.
- `summary`, `reasoning` — the agent's write-up.
- `observations` — incidental findings, each with `kind` (`bug`, `ux`, `typo`,
  `suggestion`, `a11y`, `performance`) and `description`. An observation may
  also carry an `evidence` array of paths pointing at supporting files.
- `evidence` — pointers to files for this run:
  - `screenshots`: relative paths to screenshots
  - `log`: relative path to `run.jsonl`
  - `video` (optional): relative path to a video file, if the run produced one
- `duration_ms`, `usage` — timing and token counts.

### Path references

Every path in `result.json` is a **relative path from the run directory**. To
find the file, join the path with the run root. That's the whole rule — no
subdir translation, no hidden mapping.

## HTTP access

The server exposes each run through a few endpoints under `/api/results`:

- `GET /api/results` — list runs (returns parsed `result.json` contents).
- `GET /api/results/:scenario` — one run's parsed `result.json`.
- `GET /api/results/:scenario/file/:relativePath` — fetch a file inside a run
  directory. **The file must be listed in that run's `result.json`**;
  arbitrary files on disk are not accessible through the API. Path traversal
  outside the run directory is blocked.

A screenshot listed as `"screenshots/001.png"` in the manifest is served by
`GET /api/results/login-001/file/screenshots/001.png`.

## Schema versioning

Bump `schemaVersion` when an incompatible change to `result.json` or the
directory layout lands. Additive changes (new optional fields, new
subdirectories) do not require a bump.

### Changelog

- **v1** — Initial published format.
