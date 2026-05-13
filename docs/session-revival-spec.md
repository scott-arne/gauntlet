# Session revival spec: `gauntlet ask`

Status: draft, post-review. Spec, not plan — describes *what* and *why*;
the implementation breakdown comes after.

Related:
- `docs/session-revival-research.md` — research pass, three-modes
  taxonomy, prior-art notes.
- Linear: PRI-1579.

Review pass by Cassidy@58347a0e identified four blockers and several
concerns; they're folded in below. The blocker fixes (extended-thinking
removal, REPORT_TOOL in fallback, terminal-turn tool_use handling,
image-mediaType handling) and the reflection-checkpoint replay rule are
explicit in §"How messages get rebuilt" and §"Terminal-turn handling".

## What this is

A CLI command that lets a human or another Bob open a **completed** Gauntlet
run and ask the agent that produced it questions about its decisions. No
writes back to the run. No work continues from where the agent stopped.

```
gauntlet ask <runId> [--turn N] [--model MODEL]
```

This is "mode A" — snapshot interrogation — from the research doc.
Modes B (deterministic re-execution) and C (counterfactual branching with
live tools) are out of scope.

## Why

The team is in the prompt-tuning phase. Right now, when a run produces a
surprising verdict or a sequence of head-scratching tool calls, the only
way to understand *why* is to read the transcript and reason about the
agent's state from the outside. That's slow and lossy.

Letting the operator ask the model directly — "why did you click cancel
on turn 14?", "what would have changed your verdict?" — gives a more
direct signal about what's load-bearing in the prompt and what isn't.
The win is for iteration speed on the agent prompts, not for runtime
features.

The same primitive serves Bob-on-Bob review: a coordinating Bob analyzing
batch results can query individual runs without spawning a full subagent.

## What it does, in order

1. Reads `.gauntlet/results/<runId>/run.jsonl` and `result.json`.
2. Reconstructs the agent's conversation state up to the chosen turn:
   the system prompt, the message history, and any image or large-text
   artifacts the agent saw.
3. Opens an interactive REPL. The operator types a question; the model
   answers using a single tool, `answer(answer: string)`. The REPL header
   prints provenance (`Revival of run <runId> against model <model>
   (recorded <date>)`) and each reply prints a turn-cost line
   (`tokens: 4200 in / 800 out`).
4. On exit (Ctrl-D, Ctrl-C, or `:quit`), writes nothing under
   `.gauntlet/`.

## Fidelity contract

The revival model sees what the original agent saw at turn N, with these
explicit exceptions:

- **The callable tools list is different.** The original run's callable
  tools were `[adapter.toolDefinitions(), REPORT_TOOL]`. Revival passes
  exactly one callable tool, `answer`. The original tools appear in the
  system prompt as **prose** (an addendum block) so the model knows what
  it had access to during the run — but they cannot be invoked.
- **No extended thinking.** Recorded runs did not enable Anthropic
  extended thinking (`createAnthropicClient` does not pass
  `thinking: { type: "enabled" }`). Revival keeps thinking off so the
  request shape stays compatible with the recorded assistant turns,
  which have no signed thinking blocks. The model still explains its
  reasoning — just inside the `answer` text, not as a separate block.
- **Cache breakpoints are reset.** Revival is a fresh API conversation;
  the recorded run's prompt cache is gone. Performance cost only.
- **A revival framing prepends the system prompt.** A short addendum
  tells the model it's in a post-run review, lists the original tool
  definitions as prose, and instructs it to answer using only `answer`.
  Stable across questions in a session so the cache hits.

Everything else — system prompt body, raw assistant messages (text and
`tool_use` blocks intact), `tool_result` content (rehydrated from disk
when bytes were spilled) — is byte-identical to what the agent loop fed
the model.

## Model pinning

Revival pins to the model recorded at `run_start.model` (with
`result.json.config.model` as a secondary source if present).
If the model is unavailable at revival time (deprecated, retired, no API
access), the command errors with a clear message:

> Run `<runId>` was recorded against model `<recorded-model>`, which is
> no longer available. To revive against a different model, pass
> `--model <model-id>`. Note that the answers will be from a different
> model than the one that produced the original run.

No silent substitution. The whole point of revival is to ask the same
mind why it did what it did; asking a different model is a different
experiment and the operator should opt in explicitly.

`--model MODEL` accepts the same values the run-time path accepts (the
provider's model resolution; see `src/models/resolve.ts`). Override is
labelled in the REPL header.

## The `answer` tool

```
answer(answer: string)
```

A single-field tool. The model's reply to the operator's question goes
here. We chose this shape over a structured `{reasoning, answer}` split
because in practice the two fields converge when there's no structured
verdict to anchor against — the split is ceremony.

### Fallback: plain-text response

If the model emits text without calling `answer`, take the text as the
answer and mark the output `(unstructured)`. Do not loop or re-prompt —
the model has already produced its reply.

## How messages get rebuilt

The reconstruction is one function — `rebuildMessages(runDir, upToTurn?)`
— that returns:

```
{
  systemPrompt: string,              // body + revival addendum
  messages: unknown[],               // provider-native ordered array
  toolDefsProse: string,             // for inclusion in the addendum
  modelId: string,                   // pinned model from the run
  adapterName: string,               // recorded adapter
  warnings: string[],                // schema-drift, mediaType-default, etc.
}
```

Both the CLI v1 and any future programmatic API call this function.

### Cutoff rule

`upToTurn` selects the inclusion boundary. Semantics:

- `--turn N` (N ≥ 1): include every event with `turn ≤ N`, plus the
  initial `system_prompt`, `tool_definitions` (if present), and turn-0
  `user_message` events that have no `turn` field or `turn === 0`.
- `--turn 0`: include only the initial user message; no assistant turns.
- Omitted: include every event through `run_end`.

If `--turn N` is past the run's last turn (e.g., `--turn 50` on a run
that ended at turn 12), error with `--turn N out of range; run ended at
turn <lastTurn>`. The grace turn (when present) counts as a normal turn
for this purpose — it's just `lastTurn + 1` in the log.

### Event-to-message translation

Per-turn user messages are constructed by calling the **live provider client's** `userMessage(content)` and `toolResultMessages(calls, results, extraUserText?)` — never hand-rolled. This keeps the request shape provider-native (Anthropic content blocks vs OpenAI tool messages + image user messages) and identical to what the original agent loop produced. The function therefore takes a `client: Pick<LLMClient, "userMessage" | "toolResultMessages">` parameter alongside `runDir` and `upToTurn`.

Walk events in order. For each event:

- `system_prompt` → captured for `systemPrompt`. Revival framing
  (revival header + `toolDefsProse`) is appended to the body.
- `tool_definitions` (new, see below) → captured for `toolDefsProse`.
- `user_message` events — translation depends on placement:
  - **Initial user message** (`turn === 0`): emit as
    `client.userMessage(content)`.
  - **Reflection-checkpoint reminder**: a `user_message` whose `turn`
    matches the *just-emitted* `llm_response.turn` (i.e., logged AFTER
    the assistant turn produced tool calls). Detected by: a preceding
    `reflection_checkpoint` event with the same `turn`, AND that turn
    had tool calls. **Pass the content as `extraUserText` to the same
    `toolResultMessages(...)` call that wraps the turn's tool results.**
    Do NOT emit it as a standalone user message — for Anthropic that
    would produce two adjacent user turns, which is illegal. (The
    research doc and the v0 spec got this wrong; this is Cassidy's C3.)
  - **Deadline-grace reminder**: a `user_message` whose `turn` is
    `lastTurn + 1` and is preceded by a `deadline_reminder` event,
    *not* by a `tool_call`/`tool_result` group at that turn. Emit as a
    standalone `client.userMessage(content)`.
- `llm_response` → append `rawAssistantMessage` verbatim to `messages`.
- `tool_call` + `tool_result` pairs for the same turn → group by turn,
  build via `client.toolResultMessages(calls, results, extraUserText?)`,
  passing the reflection reminder (if any) as `extraUserText`.
  `results` are `ToolResult` objects reconstructed from the logged
  `tool_result` events; rehydration:
  - **Image rehydration.** `tool_result.image` is a relative path
    (e.g. `screenshots/001.png`). The rebuilder reads the file,
    base64-encodes it, and fills `result.image = { data, mediaType }`.
    `mediaType` source: if the logged `tool_result` event carries
    `mediaType` (new field, see "Required run.jsonl changes" below),
    use it. Otherwise default to `image/png` (matches what the current
    screenshot pipeline produces — `saveScreenshot` always writes PNG),
    and append a warning to `warnings`.
  - **Text rehydration.** `tool_result.textTruncated === true` means
    the original text spilled to `artifacts/N.txt`. Read the artifact
    and put the full text back into `result.text`.
  - **TUI captures.** `tool_result.capturePath` points at
    `captures/NNN.ansi`. The agent loop already feeds the ANSI to the
    model via `ToolResult.text`; the rebuilder mirrors that — read the
    `.ansi` file into `result.text`.

### Terminal-turn handling (Cassidy's B3)

The final `llm_response.rawAssistantMessage` of a run can contain
`tool_use` blocks that have no matching `tool_result`. This happens in
three recorded shapes:

1. `report_result` was the terminal action — the agent loop returns
   immediately after `parseReportResult` (`agent.ts:281-312`). The
   `tool_use` block for `report_result` is in the raw message; no tool
   ran.
2. `report_result` was emitted alongside other tools, which were
   dropped per the "drop other tools on report_result" policy. Those
   dropped `tool_use` blocks are in the raw message.
3. The grace turn produced a malformed `report_result` (or no tool
   call at all), and the run exited.

In all three cases, the rebuilt assistant turn has dangling `tool_use`
blocks. Anthropic's API rejects an assistant turn whose `tool_use`
blocks aren't followed by matching `tool_result` blocks in the next
user turn.

**Rule:** after appending the final assistant message, the rebuilder
inspects it for `tool_use` blocks that have no corresponding
`tool_result` event. For each, it synthesizes a stub user turn whose
content is a `tool_result` block with the unmatched `tool_use_id` and
text `"[revival: tool was not executed during the original run]"`.
These stub tool_results are emitted in a single user turn; the
operator's first question then becomes the *next* user turn naturally.

Why synthesize rather than trim: trimming the assistant message would
remove the `report_result` content from the operator's view —
specifically the args the model passed to it, which often *are* what
the operator wants to ask about ("why did you summarize the run as
X?"). Keeping the assistant message intact preserves that.

### What the rebuilt message array looks like

For a hypothetical 3-turn run ending in `report_result`:

```
[
  // turn 0 / initial
  user("Test the login flow against http://localhost:3000")
  // turn 1: assistant clicked
  assistant([tool_use: click_button, text: "I'll start by..."])
  user([tool_result: click_button → "ok"])
  // turn 2: assistant typed
  assistant([tool_use: type_text])
  user([tool_result: type_text → "ok"])
  // turn 3: assistant reported
  assistant([tool_use: report_result {status: "pass", ...}, text: "Done."])
  // synthesized stub for the dangling report_result tool_use
  user([tool_result: report_result → "[revival: tool was not executed during the original run]"])
  // ↑ operator's first question is the next user turn after this
]
```

## Required `run.jsonl` changes

Two additive event/field changes. Neither requires a `schemaVersion` bump
in `result.json` (additive events and fields are explicitly allowed by
`docs/format.md`'s changelog policy).

1. **New `tool_definitions` event.** Written immediately after
   `system_prompt` at run start. Body:

   ```json
   {
     "type": "tool_definitions",
     "tools": [/* the full [...adapter.toolDefinitions(), REPORT_TOOL] array */]
   }
   ```

2. **New `mediaType` field on `tool_result` events with images.** When
   `tool_result.image` is populated, also emit
   `mediaType: "image/png"` (or whatever the actual type is). Today
   that's always `image/png`; preserving the field guards against
   future image-producing tools.

Old runs (no `tool_definitions` event) revive with a fallback path:
- The rebuilder calls `adapter.toolDefinitions()` for the recorded
  adapter name and appends `REPORT_TOOL`. The prose addendum lists
  this fallback set with a `[fallback — schemas may have drifted]`
  marker.
- If the recorded adapter name is no longer registered (adapter was
  renamed or removed between record and revival), the CLI **errors**
  with a message naming the missing adapter and pointing to
  `--model`-style override docs. We do not silently list "no tools"
  to the model.
- A drift warning goes into the REPL header and the returned
  `warnings` array.

Also update `docs/format.md`'s event list (lines 18-25) when the new
event ships, so the next reader doesn't think `tool_definitions` is
undocumented drift.

## Failure modes the CLI must handle

- Run directory missing → clear error.
- `run.jsonl` missing or empty → clear error ("run did not produce a
  transcript; cannot revive").
- Model unavailable → see §"Model pinning".
- Adapter no longer registered (old run, fallback path) → see above.
- `--turn N` out of range → clear error with the run's last turn.
- API error during a revival turn → print the error, don't crash the
  REPL; let the operator try a different question or quit.

## Out of scope

- **Counterfactual branching (mode C).** Continuing the agent loop from
  turn N with live tools is a separate, larger piece of work. The
  rebuild function is designed so it's the same code path whichever
  mode plugs in on top, but no continuation logic ships here.
- **Web UI integration.** The CLI is the v1 surface. Adding a "chat
  with this run" panel to the Gauntlet UI is a follow-on; the API
  primitive it would need (`rebuildMessages` + a thin `askOnce(runId,
  question, opts)` helper) is designed in v1 so the UI is reachable
  without a refactor.
- **Logging tool versions / adapter version.** Drift between record and
  revival is real but tractable later — log a version string at
  run_start and warn on mismatch. Not blocking.
- **Multi-run interrogation.** "Which run had the longest click chain
  on a login form?" is a query over many runs, not a conversation with
  one. Not this primitive.

## Resolved design choices

These were the open questions; resolutions recorded so the spec stands
on its own.

1. **`--turn N` semantics.** `N` means "complete turn N, then stop."
   The reconstructed conversation includes the agent's turn-N response
   (and any tool results that turn produced). The operator's question
   sits where turn N+1's user message would normally go. `--turn 0`
   means "before any assistant response." Omitted means "include the
   whole run through `run_end`."
2. **Backward-compatible tool-defs fallback.** For runs without the
   new `tool_definitions` event, fall back to live
   `adapter.toolDefinitions()` + `REPORT_TOOL` with a drift warning.
   If the recorded adapter is no longer registered, error (don't
   silently list nothing).
3. **REPL niceties.** `:turn N`, `:show N`, and similar deferred to
   v1.1. v1 ships a plain prompt-and-response REPL with header
   (provenance), per-reply usage line, and three exit triggers
   (Ctrl-D, Ctrl-C, `:quit`).
4. **No writes.** Revival sessions write nothing under `.gauntlet/`.
   Operating-system-level traces (shell history, Anthropic prompt
   cache, etc.) are acknowledged but not load-bearing — the contract
   is about the run directory.
5. **Extended thinking off.** Removed from v1 because recorded runs
   don't have signed thinking blocks; enabling thinking on revival
   would change the request shape in ways the recorded turns can't
   satisfy. The model's reasoning lives in the `answer` text.
6. **Terminal-turn dangling `tool_use`.** Synthesize a stub
   `tool_result` user turn for any unmatched `tool_use` in the final
   assistant message, with text `"[revival: tool was not executed
   during the original run]"`. Don't trim the assistant message —
   preserving `report_result` args matters for "why did you summarize
   it that way" questions.
