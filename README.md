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
                  ┌─────────────┐
                  │  Story Cards │  (markdown files with YAML frontmatter)
                  └──────┬──────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   CLI commands     HTTP API + UI    Fanout generator
   (run, validate)  (Hono server)    (AI-generated variations)
        │                │
        └────────┬───────┘
                 │
           ┌─────┴─────┐
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

Test scenarios are markdown files with YAML frontmatter:

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

Fields: `id` (required), `title` (required), `status` (draft/ready), `tags`, `parent` (for variations), `stakeholder`.

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

# Run with a specific model and adapter
gauntlet run scenario.md --target http://localhost:3000 --model claude-sonnet-4-20250514 --adapter web

# Validate a story card's format
gauntlet validate scenario.md

# Generate test variations from a story card
gauntlet fanout scenario.md --out ./stories

# Generate follow-up scenarios from a previous result
gauntlet fanout --from-result ./results/run-001 --out ./stories

# Start the web server — point --data-dir at a project's .gauntlet directory
gauntlet serve --port 4400 --data-dir ../my-app/.gauntlet
```

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
| `/api/run/:id` | POST | Execute a scenario |
| `/api/results` | GET | List all results |
| `/api/results/:id` | GET | Get result metadata |
| `/api/results/:id/video` | GET | Stream test video |
| `/api/results/:id/screenshots/:name` | GET | Get a screenshot |
| `/api/fanout/:id` | POST | Generate test variations |
| `/api/fanout/:id/observations` | POST | Generate cards from observations |
| `/api/fanout/:id/failure` | POST | Generate cards from a failure |
| `/api/ws` | WS | WebSocket for live run streaming |

## Docker

The quickest way to run Gauntlet is with Docker Compose:

```bash
cp .env.example .env    # then fill in your API keys
docker compose up
```

By default this mounts `./.gauntlet` (relative to `compose.yaml`) as the data directory, which is convenient for running Gauntlet against itself. Story cards live at `.gauntlet/stories/` and run artifacts (screenshots, videos, agent reasoning, `result.json`) at `.gauntlet/results/`. Story cards are meant to be committed with your repo; run results are gitignored by default.

### Pointing Gauntlet at another project

Set `TARGET_PROJECT` to the path of the project you want to test — either in `.env` or on the command line:

```bash
TARGET_PROJECT=/Users/you/Code/my-app docker compose up
```

Compose will mount `my-app/.gauntlet/` from the host, and story cards and run artifacts will live there instead. The path can be absolute or relative to `compose.yaml`.

The Docker image includes Chrome, Bun, and the pre-built UI, on Debian bookworm-slim.

### Running without Compose

```bash
docker build -f docker/Dockerfile -t gauntlet .
docker run -p 4400:4400 --env-file .env -v "/path/to/my-app/.gauntlet:/data" gauntlet serve --data-dir /data
```

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | API key for Claude models | -- |
| `OPENAI_API_KEY` | API key for OpenAI models | -- |
| `GAUNTLET_PORT` | Server port | 4400 |
| `GAUNTLET_AGENT_MODEL` | Default model for test execution | -- |
| `GAUNTLET_FANOUT_MODEL` | Model for scenario generation | -- |

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
    run.ts              `run` command
    validate.ts         `validate` command
    fanout.ts           `fanout` command
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
compose.yaml            Docker Compose entry point (mounts .gauntlet as data dir)
.env.example            Template for API keys and optional env overrides
```
