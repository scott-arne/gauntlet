# Gauntlet

Gauntlet is an AI-powered QA testing framework. It uses large language models (Claude or GPT) to test web applications the way a human tester would: navigating pages, clicking buttons, filling forms, taking screenshots, and reporting bugs. You write test scenarios as markdown "story cards," and Gauntlet's AI agent works through them in a real browser, delivering a verdict (pass/fail/investigate) with evidence.

## What it does

1. **You describe what to test** in a story card -- a markdown file with a title, description, and acceptance criteria.
2. **An AI agent opens a real browser**, navigates to your application, and interacts with it using Chrome DevTools Protocol.
3. **The agent explores and evaluates** your acceptance criteria, but also reports anything else it notices: bugs, UX issues, typos, accessibility problems, performance issues, and suggestions.
4. **You get a structured result** with a verdict, reasoning, observations, screenshots, and an action log.

Beyond single-scenario testing, Gauntlet can **generate test variations** ("fanout") from a parent story card -- producing edge-case, error-path, and alternate-persona scenarios automatically. It can also generate follow-up scenarios from observations or failures in previous runs.

## Architecture

```
                  ┌──────────────┐
                  │  Story Cards │  (markdown files with YAML frontmatter)
                  └──────┬───────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   CLI commands     HTTP API + UI    Fanout generator
   (run, validate)  (Hono server)    (AI-generated variations)
        │                │
        └────────┬───────┘
                 │
           ┌─────┴──────┐
           │   Agent    │  (agentic loop: LLM + browser tools, up to 50 turns)
           └─────┬──────┘
                 │
        ┌────────┼────────┐
        │        │        │
   LLM Client  Browser   Evidence Logger
   (Claude or   Adapter   (screenshots,
    OpenAI)    (CDP)      action log)
```

### Tech stack

- **Runtime**: [Bun](https://bun.sh) (TypeScript)
- **Server**: [Hono](https://hono.dev) (minimal web framework)
- **Frontend**: React 19 + React Router 7 + Vite + Tailwind CSS
- **Browser automation**: Chrome DevTools Protocol (custom CDP library)
- **AI providers**: Anthropic SDK (Claude) and OpenAI SDK
- **Deployment**: Docker (Debian + Chrome + Bun)
- **Storage**: File-based (no database) -- markdown for scenarios, JSON for results

## How it works

### Story cards

Test scenarios are markdown files (conventionally named `scenario.md`) with YAML-style frontmatter followed by a markdown body:

```markdown
---
id: login-001
title: User can log in with valid credentials
status: ready
tags: auth, smoke
stakeholder: end-user
---

Test the login flow for a registered user.

## Acceptance Criteria

- User can enter email and password
- Clicking "Log in" with valid credentials navigates to the dashboard
- Error message is shown for an incorrect password
```

**Frontmatter** (delimited by `---` lines, one `key: value` per line):

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Stable identifier for the card (used in URLs and filenames) |
| `title` | yes | One-line human-readable summary |
| `status` | no | `draft` or `ready` (defaults to `draft`). Only `ready` cards are surfaced for routine runs |
| `tags` | no | Comma-separated list (e.g. `auth, smoke`) |
| `stakeholder` | no | Whose perspective the test takes (e.g. `end-user`, `admin`) |
| `parent` | no | `id` of the parent card -- set automatically on fanout-generated variations to link back to the source. Lineage only; it does **not** imply run order or a dependency between cards. |

The frontmatter parser is intentionally minimal: it splits on the first `:` per line, so values are plain strings -- do not quote them and do not use nested YAML structures.

**Body**: free-form markdown describing the scenario. Everything before the `## Acceptance Criteria` heading is treated as the description and passed to the agent as context. Lines under `## Acceptance Criteria` that begin with `- ` are parsed as individual criteria; the agent evaluates each one and the verdict reflects whether they all hold. The `## Acceptance Criteria` section is optional -- a description-only card is valid.

You can validate a card's format with `gauntlet validate scenario.md`.

Each file holds exactly one card: one frontmatter block, one description, one optional `## Acceptance Criteria` list. `gauntlet run` executes one card in one agent loop; `gauntlet batch` (see [Batch mode](#batch-mode) below) takes a set of card paths and runs them serially with a live progress display and an aggregate exit code.

**Copy-paste template** -- a minimal card you can drop into a new `scenario.md` and edit:

```markdown
---
id: my-card-001
title: Short description of what this tests
status: draft
tags: smoke
stakeholder: end-user
---

Describe the scenario here: what the tester should do, any setup or context
they need, and what a successful run looks like.

## Acceptance Criteria

- First thing that must be true
- Second thing that must be true
- Third thing that must be true
```

### The agent loop

The core of Gauntlet is an agentic loop in `src/agent/agent.ts`:

1. The story card is loaded and a system prompt is built, instructing the LLM to act as a thorough QA tester.
2. The LLM is given browser tools (screenshot, click, type, press, navigate, extract, eval, wait_for) plus a special `report_result` tool.
3. On each turn, the LLM decides what to do -- take a screenshot, click a button, type into a form, etc. Tool results (including screenshot images) are fed back into the conversation.
4. The loop continues until the agent calls `report_result` with its verdict, or hits the 50-turn limit.
5. Each tool call has a 30-second timeout to prevent hangs.

The agent reports:
- **Status**: `pass`, `fail`, or `investigate`
- **Summary and reasoning**: what happened and why
- **Observations**: an array of `{kind, description}` where kind is one of: `bug`, `ux`, `typo`, `suggestion`, `a11y`, `performance`

### Browser adapter

The web adapter (`src/adapters/web/adapter.ts`) drives Chrome via CDP and exposes eight tools to the agent:

| Tool | Description |
|------|-------------|
| `screenshot` | Capture the page or a specific element (returns image to the LLM) |
| `click` | Click an element by CSS selector |
| `type` | Type text into an element |
| `press` | Press a key (Enter, Tab, Escape, etc.) |
| `navigate` | Go to a URL |
| `extract` | Convert the page (or element) to markdown text |
| `eval` | Run a JavaScript expression in the page |
| `wait_for` | Wait for an element or text to appear |

Most tools support `return_screenshot` to automatically capture the page state after the action.

### LLM providers

Gauntlet supports two providers via a common `LLMClient` interface:

- **Anthropic** (`src/models/anthropic.ts`): Uses Claude with prompt caching (ephemeral markers on system prompt, tools, and the last message) to reduce token costs on long agent runs.
- **OpenAI** (`src/models/openai.ts`): Standard chat completions API.

### Fanout: test variation generation

The fanout system (`src/fanout/generator.ts`) uses an LLM to automatically generate additional test scenarios from a parent card. Three modes:

- **Variations**: Edge cases, error paths, alternate personas, boundary conditions (3-5 generated per parent card).
- **From observations**: Promotes observations from a test run (bugs, UX issues, etc.) into focused follow-up story cards.
- **From failures**: When a test fails, generates 2-3 root-cause investigation scenarios.

Generated cards include `parent` linking back to the source and are validated against the story card format before being saved.

### Evidence collection

During each run, the `EvidenceLogger` captures:
- **Screenshots**: PNG images saved to a `screenshots/` directory
- **Action log**: A JSONL file recording every tool call and its arguments
- **Video**: Frame capture for playback in the UI

Results are written to a `results/` directory as `result.json` alongside the evidence files.

## Usage

### CLI

```bash
# Run a test scenario against a target URL
gauntlet run scenario.md --target http://localhost:3000

# Run with a specific model, adapter, viewport, and turn cap
gauntlet run scenario.md --target http://localhost:3000 --model agent=claude-sonnet-4-6 --adapter web --viewport 1440x900 --turns 50

# Stream machine-readable events instead of the pretty terminal transcript
gauntlet run scenario.md --target http://localhost:3000 --format jsonl

# Suppress the run transcript and only print the runId on stderr
gauntlet run scenario.md --target http://localhost:3000 --silent

# Run a set of cards serially with a live progress display
gauntlet batch story-a.md story-b.md --target http://localhost:3000

# Glob-expanded set; exit 0 iff every card passes, 1 otherwise
gauntlet batch stories/*.md --target https://staging.example.com

# Validate a story card's format
gauntlet validate scenario.md

# Generate test variations from a story card
gauntlet fanout scenario.md --out ./stories

# Generate follow-up scenarios from a previous result
gauntlet fanout --from-result ./results/run-001 --out ./stories

# Start the web server — point --project-dir at the project's root
# (Gauntlet writes state to <project>/.gauntlet/).
gauntlet serve --port 4400 --project-dir ../my-app
```

### Batch mode

`gauntlet batch <story.md> [more.md ...] --target <url>` runs N cards
serially. The active card sits at the bottom as a single redrawing
spinner line; finished cards stack above as committed result rows. The
final summary tells you where evidence landed.

```
Gauntlet · 3 cards · target https://app.local

  ✓ login-matt              pass          6 turns · 4.2s
        → /…/.gauntlet/results/login-matt_…/
  ! login-not-logged-in     investigate   9 turns · 8.1s
        → /…/.gauntlet/results/login-not-logged-in_…/
  ⠋ [3/3] login-locked-out   turn 4 / 10

batch: 1 pass · 0 fail · 1 investigate · 0 errored
results: /…/.gauntlet/results
```

Per-card flags (`--target`, `--adapter`, `--model`, `--chrome`,
`--turns`, `--viewport`, `--save-screencast`, `--project-dir`) apply
uniformly to every card. `--out` is rejected — each card uses its
default per-run directory under `<.gauntlet>/results/<runId>/`.

Output modes:

- **Default** (TTY): the live ticker shown above.
- **`--format jsonl`**: every per-event log line on stdout, with
  `runId` injected. No table. This is the CI / machine-readable mode.
- **`--silent`**: stdout is empty; the one-line summary lands on
  stderr. The exit code (`0` iff every card is `pass`, `1` otherwise)
  is the only other signal.

Errors don't abort the batch — a card that throws is marked errored
and the loop moves on. Concurrent execution (`-j N`) isn't implemented
yet; v1 is strictly serial.

To see Chrome's launch banners (silent by default to keep the ticker
clean), set `GAUNTLET_CHROME_VERBOSE=1`.

### Web UI

Run `gauntlet serve` to start the server (default port 4400). The UI provides:

- **Cards view**: Browse, create, and edit story cards in a sidebar-driven interface.
- **Runs view**: See all test results with status badges (pass/fail/investigate), view summaries, observations, and screenshot evidence.
- **Run detail**: Watch video playback of the test, read the agent's reasoning, see token usage, and trigger fanout (generate variations, investigate failures).
- **Live run**: Start a test from the UI and watch it execute in real-time via WebSocket -- see the browser frames update and the LLM's output stream in.

### API

The HTTP API (Hono) serves at `/api`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scenarios` | GET | List all story cards |
| `/api/scenarios` | POST | Create a new story card |
| `/api/scenarios/:id` | GET | Get a single card |
| `/api/scenarios/:id` | PUT | Update a card |
| `/api/scenarios/:id` | DELETE | Delete a card |
| `/api/scenarios/:id/approve` | POST | Set card status to ready |
| `/api/run/:id` | POST | Execute a scenario; returns `{ runId, cardId }` |
| `/api/results` | GET | List all results |
| `/api/results/:runId` | GET | Get result metadata |
| `/api/results/:runId/file/:path` | GET | Fetch a file from a run (must be listed in result.json) |
| `/api/fanout/:id` | POST | Generate test variations |
| `/api/fanout/:id/observations` | POST | Generate cards from observations |
| `/api/fanout/:id/failure` | POST | Generate cards from a failure |
| `/api/ws?run=<runId>` | WS | WebSocket for live run streaming, scoped to one run |

## Docker

Run a scenario from the current directory against a target URL — the container mounts your working directory and reads `scenario.md`:

```bash
docker run --rm \
  -e OPENAI_API_KEY=sk-... \
  -e GAUNTLET_AGENT_MODEL=gpt-5.4-mini \
  -v "$PWD:/work" -w /work \
  gauntlet run scenario.md --target https://example.com
```

On macOS/Windows, use `--target http://host.docker.internal:3000` to reach a dev server running on the host.

The Docker image includes Chrome, Bun, and the pre-built UI. It uses Debian bookworm-slim as the base.

### Docker Compose

For persistent server use — the web UI, repeat runs, multiple scenarios — Compose is more ergonomic, mostly because it reads a `.env` file so API keys and defaults live in one place instead of on every `docker run` invocation:

```bash
cp .env.example .env    # then fill in your API keys
docker compose up
```

By default this mounts `.` (the Gauntlet repo itself) as the project root and Gauntlet writes state under `./.gauntlet/`. Story cards live at `.gauntlet/stories/`, run artifacts at `.gauntlet/results/`.

## Configuration

Gauntlet loads its runtime configuration once at startup via `loadConfig(argv, env)`. The result is an `AppConfig` object that flows explicitly through every command, route factory, and adapter. There is exactly one place that reads `process.env` for Gauntlet-level config; everything else takes its inputs as arguments.

### Precedence

```
defaults < environment variables < CLI flags < per-request body (web only)
```

The web `POST /api/run/:id` body is validated against an explicit allow-list. Unknown fields are rejected with HTTP 400. Every field exposed to the web is a conscious decision.

### CLI flags per command

| Command | Flag | Description |
|---------|------|-------------|
| `run` | `--target <url>` | (required) Application under test |
| `run` | `--model agent=<name>` | Model for the agent |
| `run` | `--chrome host:port` | Chrome debugging endpoint |
| `run` | `--adapter web\|cli\|tui` | Adapter type (default: web) |
| `run` | `--turns <n>` | Max agent turns for this run (default: 50) |
| `run` | `--viewport WxH` | Browser viewport for web-adapter runs (default: 1440x900) |
| `run` | `--save-screencast [bool]` | Persist screencast frames to disk (default: off; live UI stream is unchanged) |
| `run` | `--out <dir>` | Evidence output directory |
| `run` | `--project-dir <dir>` | Project root (contains `.gauntlet/` state dir) |
| `run` | `--silent` | Suppress the streaming transcript; prints only `runId` on stderr |
| `run` | `--format pretty\|jsonl` | Streaming transcript format (default: auto by TTY) |
| `run` | `--no-color` | Disable ANSI color output; `NO_COLOR` is also respected |
| `batch` | `<story.md> [more.md ...]` | Positional card paths (at least one required) |
| `batch` | `--target <url>` | (required) Application under test |
| `batch` | other per-card flags | Same as `run` minus `--out`. Applied uniformly to every card. |
| `batch` | `--silent` | Suppress the table; print only the final summary on stderr |
| `batch` | `--format pretty\|jsonl` | Output format (default: auto by TTY); jsonl injects `runId` per event |
| `batch` | `--no-color` | Disable ANSI color output; `NO_COLOR` is also respected |
| `serve` | `--port <n>` | Server port |
| `serve` | `--project-dir <dir>` | Project root (contains `.gauntlet/` state dir) |
| `serve` | `--chrome host:port` | Default Chrome endpoint for runs |
| `serve` | `--target <url>` | Default target hint for the UI |
| `serve` | `--model agent=<name>` | Default agent model |
| `serve` | `--turns <n>` | Default max turns per run (default: 50) |
| `serve` | `--viewport WxH` | Default browser viewport (default: 1440x900) |
| `serve` | `--save-screencast [bool]` | Default screencast-frame persistence (default: off) |
| `config` | `--json` | Emit JSON instead of formatted text |
| `config` | `--project-dir <dir>` | Inspect config with this project root override |
| `config` | `--port <n>` | Inspect config with this server port override |
| `config` | `--chrome host:port` | Inspect config with this Chrome endpoint override |
| `config` | `--target <url>` | Inspect config with this target override |
| `config` | `--model agent=<name>` | Inspect config with this agent model override |
| `config` | `--turns <n>` | Inspect config with this turn cap override |
| `config` | `--viewport WxH` | Inspect config with this viewport override |
| `config` | `--save-screencast [bool]` | Inspect config with this screencast override |
| `fanout` | `--out <dir>` | Output directory |
| `fanout` | `--model fanout=<name>` | Model for generation |
| `fanout` | `--from-result <dir>` | Generate from an existing result |

Unknown flags are now rejected loudly. If you mistype `--chrom` you will get an error, not silent fallthrough.

### Environment variables

Gauntlet-prefixed (consumed by `loadConfig`):

| Variable | Description | Default |
|----------|-------------|---------|
| `GAUNTLET_PORT` | Server port | `4400` |
| `GAUNTLET_PROJECT_ROOT` | Project root (contains `.gauntlet/` state dir) | `.` |
| `GAUNTLET_CHROME` | Default Chrome endpoint (`host:port`) | `127.0.0.1:9222` |
| `GAUNTLET_TARGET` | Default target URL, surfaced as a UI prefill | -- |
| `GAUNTLET_TURNS` | Default max turns per run | `50` |
| `GAUNTLET_VIEWPORT` | Default browser viewport (`WxH`) | `1440x900` |
| `GAUNTLET_SAVE_SCREENCAST` | Persist screencast frames to disk (`1/0`, `true/false`, `yes/no`, `on/off`) | `0` |
| `GAUNTLET_AGENT_MODEL` | Default agent model | `claude-sonnet-4-6` |
| `GAUNTLET_FANOUT_MODEL` | Default fanout model | -- |
| `GAUNTLET_MODELS` | Comma-separated allow-list of models (opt-in) | `[]` (no restriction) |

### SDK env pass-through policy

Gauntlet does **not** read, wrap, or re-export the SDK-native environment variables. They flow directly to the Anthropic and OpenAI SDKs via the empty-constructor pattern (`new Anthropic()`, `new OpenAI()`).

| Variable | Owned by |
|----------|----------|
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_LOG` | Anthropic SDK |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT` | OpenAI SDK |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Both SDKs (via Node) |

If you want to point Gauntlet at a custom Anthropic endpoint, set `ANTHROPIC_BASE_URL=https://your-gateway.example.com` directly. Gauntlet will not touch it; the SDK will.

`gauntlet config` records the *presence* of API keys in its output (`apiKeys.anthropic: set`) but never their values.

### Inspecting effective config

```bash
gauntlet config              # formatted text with per-field source attribution
gauntlet config --json       # machine-readable
GAUNTLET_PORT=5500 gauntlet config --project-dir /tmp/x
#   port:           5500  (env)
#   projectRoot:    /tmp/x  (flag)
```

The same payload is available over HTTP at `GET /api/config/effective` once the server is running.

### Docker / compose pattern

Use `GAUNTLET_CHROME` to point at a sidecar Chrome service:

```yaml
services:
  gauntlet:
    environment:
      GAUNTLET_CHROME: chrome:9222
      GAUNTLET_AGENT_MODEL: claude-sonnet-4-6
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
```

## Environment variables

See the [Configuration](#configuration) section above for the full list. Quick reference:

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | API key for Claude models | -- |
| `OPENAI_API_KEY` | API key for OpenAI models | -- |
| `GAUNTLET_PORT` | Server port | 4400 |
| `GAUNTLET_PROJECT_ROOT` | Project root (contains `.gauntlet/` state dir) | `.` |
| `GAUNTLET_CHROME` | Default Chrome endpoint | `127.0.0.1:9222` |
| `GAUNTLET_TARGET` | Default target URL for the web UI | -- |
| `GAUNTLET_TURNS` | Default max turns per run | 50 |
| `GAUNTLET_VIEWPORT` | Default browser viewport | `1440x900` |
| `GAUNTLET_SAVE_SCREENCAST` | Persist screencast frames to disk | `0` |
| `GAUNTLET_AGENT_MODEL` | Default model for test execution | `claude-sonnet-4-6` |
| `GAUNTLET_FANOUT_MODEL` | Model for scenario generation | -- |
| `GAUNTLET_MODELS` | Comma-separated model allow-list (opt-in) | `[]` (no restriction) |

## Project structure

```
src/
  index.ts              CLI entry point and command router
  types.ts              Core types (VetResult, Observation, etc.)
  agent/
    agent.ts            Agentic loop: LLM + tools for up to 50 turns
    prompts.ts          System prompt construction from story cards
  models/
    provider.ts         LLM client interface
    anthropic.ts        Claude client (with prompt caching)
    openai.ts           OpenAI client
    resolve.ts          Model string -> client instantiation
  adapters/
    adapter.ts          Abstract adapter interface
    web/adapter.ts      Chrome CDP browser adapter (8 tools)
    cli/adapter.ts      Terminal-based adapter
    tui/adapter.ts      Text UI adapter
  api/
    server.ts           Hono app with API routes + static UI serving
    ws.ts               WebSocket broadcaster for live runs
    routes/             HTTP route handlers (scenarios, results, run, fanout)
    safe-path.ts        Path traversal protection
  cli/
    args.ts             CLI argument parsing
    run.ts              `run` command (single-card streaming wrapper)
    run-one.ts          Engine shared by `run` and `batch` (constructs
                        EvidenceLogger, drives runAgent, owns adapter lifecycle)
    batch.ts            `batch` command — serial runner + per-card observer
    validate.ts         `validate` command
    fanout.ts           `fanout` command
    stream/             Streaming-transcript renderers for run/batch
                        (pretty, jsonl, batch-table)
  fanout/
    generator.ts        AI-powered test variation generation
  evidence/
    logger.ts           Screenshot/action capture during runs
    writer.ts           Result serialization to disk
  format/
    story-card.ts       Story card parsing and serialization
  streaming/
    screencast.ts       Browser frame capture
ui/
  src/
    App.tsx             React Router setup
    components/         CardsList, CardEditor, RunsList, RunDetail, LiveRun, etc.
    hooks/              Data-fetching hooks (useCards, useResults, useRunStream)
    lib/api.ts          HTTP client for the backend API
docker/
  Dockerfile            Production image (Debian + Chrome + Bun)
  Dockerfile.chrome     Standalone headless Chrome image (separate target)
compose.yaml            Docker Compose entry point (mounts project root at /project)
.env.example            Template for API keys and optional env overrides
```
