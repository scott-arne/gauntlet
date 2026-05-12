# Reflection Checkpoints — Spec

**Status:** draft, pending sign-off
**Author:** Granny@ff86836c (Opus 4.7)
**Date:** 2026-05-12

## Problem

The agent loop has no mechanism to recognize when it has stopped making
progress. The existing `src/agent/prompts/stuck-handling.md` is read into
the system prompt once at run start; by turn 20+ it is buried under
megabytes of tool-call/tool-result traffic and stops driving behavior.

Empirical evidence from `examples/tutorial/.gauntlet/results/`: a
representative `tutorial-04-login-credentials` run burned 23 tool calls
(24 LLM turns) without ever calling `report_result`, and ultimately hit
the deadline grace path. Several sibling runs in that directory show the
same shape — the agent keeps trying variations rather than concluding
the target may be broken.

The agent needs a periodic, in-context invitation to step outside its
trajectory and judge it from outside.

## Approach

Inject a `<SYSTEM-REMINDER>` block periodically into the user-message
stream. The reminder contains:

1. A literal trace of recent mutating tool calls (the substrate for
   reflection).
2. A question framed around "stories/fixtures/systems can be wrong" — the
   load-bearing frame that gives the agent permission to conclude the
   target is broken rather than itself.

The reminder text is **identical every firing**. The trace is fresh
every firing. The trace does the escalation: by the third checkpoint,
the agent sees three rounds of variations on the same approach laid out
literally, which is more persuasive than any tonal escalation in the
framing text.

This extends a pattern the codebase already uses: the deadline grace turn
in `src/agent/agent.ts:393-406` already injects a `<SYSTEM-REMINDER>`
block to nudge the agent into calling `report_result`. We are
generalizing that mechanism to fire mid-loop.

## Why a trace, not "reflect on your last attempts"

Asking the agent to reflect from memory is unreliable — mid-loop it will
typically answer "yes, I'm making progress" because its last tool call
returned *something*. Showing it a flat list of the actions it has
actually taken is the persuasive lever. The agent reading its own log is
doing the work the prompt can't do for it.

We considered detecting semantic repetition in code (e.g. "agent tried
the same click 4 different ways"). Rejected: the only entity that can
judge semantic equivalence is the agent itself, and any heuristic
sophisticated enough to catch it would be doing the agent's job. Cheap
byte-equality and consecutive-error detection are a rounding error on
the real problem and add complexity for negligible signal.

## Design

### Cadence

Fire every **N=10** assistant turns (configurable). First firing at
turn 10, then 20, 30, ...

Trigger is unconditional cadence (no signal-based gating). This is
deliberate: see "Why a trace" above. The agent decides; the system
provides the substrate.

### Injection mechanism

The agent loop builds messages as `[user_initial, assistant(tool_use),
user(tool_result), assistant(tool_use), user(tool_result), ...]`.
Provider rules forbid two consecutive user messages, so the reflection
cannot be injected as a standalone user turn.

Instead, **append the reflection text as an additional text block inside
the user message that carries the most recent tool results.** The
`client.toolResultMessages` shape returns one user message containing
`tool_result` blocks; we add a trailing text block to that message
before pushing it onto `messages`.

The injected reminder stays in conversation history (option **A** from
the design discussion). This:

- Preserves prompt caching from prior turns (the prefix up to the
  injection is unchanged).
- Lets later reminders be visible when earlier ones fired ("this is the
  third time I've been nudged" is itself signal to the agent).
- Costs ~200 tokens per firing — negligible.

### Trace content

Render the last **8 mutating tool calls** preceding the reminder, in
order. Informational tools (screenshots, reads, extracts — anything that
observes state without changing it) are excluded: they happen frequently,
carry no decisional signal, and dilute the trace.

Format:

```
  1. click(selector="#login-btn")
  2. eval("document.querySelector('#login-btn').click()")
  3. click(text="Sign in")
  4. type(selector="input[name=username]", value="deborah")
  5. click(selector="button[type=submit]")
  6. eval("...")
  7. click(selector="#login-btn")
  8. type(selector="input[name=password]", value="...")
```

Arguments rendered **literally** — the literal selector string, the
literal eval expression. Do not summarize. Summarizing throws away the
exact signal that makes repetition visible to the model.

Long argument values (>120 chars) are truncated with an ellipsis.
For tools with many args we render `tool(k1=v1, k2=v2, ...)`.

#### Action vs. informational classification

The action/informational partition is **per-adapter**, exposed via a new
adapter method (e.g. `isMutatingTool(name: string): boolean`). Each
adapter classifies its own tools — the agent loop has no business
hardcoding tool names. Indicative classification:

- **Web adapter:** mutating = `click`, `type`, `press`, `eval`,
  `navigate`, `upload`. Informational = `screenshot`, `extract`, `read`.
- **TUI adapter:** mutating = `send_keys`, `type`. Informational =
  `read_screen`.

If the partition is wrong for some tool, the cost is bounded: a noisy
trace, not a broken loop. Adapters can refine over time.

### Reminder text

Single reminder, used at every checkpoint:

```
<SYSTEM-REMINDER>
Reflection checkpoint.

Here are the actions you've taken that changed application state:

{TRACE}

Look at that list. Are you converging on the goal, or circling it?

Not all stories can be accomplished. Stories can be wrong. Fixtures can
be wrong. Systems can be wrong. If the most likely explanation for what
you're seeing is that the target is broken rather than that you haven't
found the right incantation, call report_result with status=investigate
and say so.

A clear "stuck on X" report — naming what you tried, what you observed,
and your best guess about what's wrong (target, fixture, story, or your
own approach) — is more valuable than burning budget on more variations.
</SYSTEM-REMINDER>
```

The reminder is **prompt-only**, never enforced. No tool-stripping or
forced exit at any number of firings — this matches the existing
`maxStuckRetries` posture. The deadline grace path remains the only
hard-stop in the loop.

**Rationale for no escalation.** Earlier drafts of this spec included
three escalating levels (gentle / pointed / terminal). The terminal
level effectively encoded a soft cap at turn 30, which is the wrong
abstraction: the time budget is the cap, and a turn-count cap punishes
hard-but-legitimate tasks while not actually helping with the real
problem (recognition, not limit). The trace embedded in each reminder
changes every firing — by the third checkpoint the agent sees the
literal evidence of its own loop, which is more persuasive than any
tonal escalation in the framing.

## Configuration

- **Env var:** `GAUNTLET_REFLECTION_INTERVAL` (positive integer, default
  `10`). Set to `0` to disable.
- **CLI flag:** `--reflection-interval N`.
- **Config field:** `defaultReflectionInterval` in app config; threaded
  through to `AgentOptions.reflectionInterval`.

Naming follows the existing `maxStuckRetries` / `GAUNTLET_MAX_STUCK_RETRIES`
pattern.

## Evidence logging

Each checkpoint emits:

1. A `reflection_checkpoint` event via `logger.logEvent`, with
   `{ turn, ordinal, traceLength }` (ordinal = 1, 2, 3, ... — useful for
   post-hoc analysis even though it does not affect prompt content).
2. The injected text is captured as a `user_message` log row (same shape
   as the deadline grace reminder), so it appears in `run.jsonl` and
   show-prompt output.

## Out of scope (for this spec)

- Signal-based triggers (repeated identical tool calls, consecutive
  errors). Possible future addition, but the cadence-only design must
  prove out first. Adding signals later is purely additive.
- Tightening the existing `stuck-handling.md` system-prompt block —
  separate question. The reflection checkpoints supersede its
  practical effect; we can decide later whether to remove it.
- Adjusting `maxStuckRetries` semantics. Left as-is.
- Per-card cadence overrides. Global default is sufficient until we
  see runs.

## Acceptance

- Every run with `> reflectionInterval` LLM turns shows at least one
  `reflection_checkpoint` event in its `run.jsonl`.
- The injected text appears as a `user_message` row in the evidence log
  with the literal trace embedded.
- On the `tutorial-04-login-credentials` fixture that has historically
  produced "burn the budget without reporting" failures, the agent calls
  `report_result` (any status) before hitting the deadline grace path on
  a majority of runs. (Eval design TBD — likely a small `run-sets`
  configuration.)
- `bun test` passes; new unit tests cover trace rendering (argument
  truncation, level selection, ordering).

## Implementation pointers (for the Plan that follows)

- Inject site: `src/agent/agent.ts` while loop at line 220; after
  building `results` and just before `messages.push(...client.toolResultMessages(...))`,
  decide whether this turn is a checkpoint and either append a text
  block to the resulting user message or pass the reminder through a
  helper that wraps `toolResultMessages`.
- Trace source: walk `response.toolCalls` history. The agent loop does
  not currently retain a flat list of past tool calls — we'll maintain
  a sidecar `recentMutatingCalls: ToolCall[]` array in `runAgent`,
  filtered by `adapter.isMutatingTool` at append time. Bounded length
  (e.g. last 16 retained, last 8 rendered).
- Adapter interface change: add `isMutatingTool(name: string): boolean`
  to the `Adapter` interface in `src/adapters/adapter.ts`. Each
  adapter implements its own classification.
- Argument rendering helper: pure function, unit-testable, lives
  alongside the prompts module (e.g. `src/agent/reflection.ts`).
