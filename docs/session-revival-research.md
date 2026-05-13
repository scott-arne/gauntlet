# Session revival: research notes

Status: research / pre-spec. Author: Ianto@7f02be88 (Bob session). Date: 2026-05-12.

The goal: let a human or agent open a completed Gauntlet run and **chat with the
agent that produced it** — ask "why did you do X?", "what would have changed
your mind?", "what were you considering on turn 14?" — without continuing the
run or writing back to it.

This document is the field notes from a research pass: what's the right shape
for "revival", what prior art says about it, what `run.jsonl` already gives us,
and what gaps remain. It is **not** the implementation spec yet.

---

## 1. Three modes, only one of which is "replay"

The phrase "replay an agent run" gets used for at least three different
things in the literature. Conflating them costs you the design.

| Mode | What it does | What it needs | What it's good for |
|---|---|---|---|
| **A. Snapshot interrogation** | Reconstruct messages[0..N] from a recorded run, append a *new* user question, ask the model once. No tool execution. No continuation. | Faithful replay of system prompt, tool *definitions*, prior assistant/user messages including raw assistant content (thinking blocks, tool_use blocks). Model identity. | "Why did you click X on turn 14?" "What would have changed your verdict?" — the Q&A use case Matt described. |
| **B. Deterministic re-execution** | Re-run the recorded trace step by step, with all tool calls and LLM calls served from a *recorded cursor* (not the live world). Verify the trace reproduces. | Everything above, plus tool *outputs* keyed by call (so deterministic replay can return them in order). Cursor discipline: fail loudly if execution diverges from trace. | Debugging the agent harness itself, regression tests, "did my parser change break replay?" |
| **C. Counterfactual branch** | Reconstruct messages[0..N], then continue with a **live** model and **live** tools, but write nothing back. | Everything mode A needs, plus a real adapter+tool runtime at the time of revival. The branch must be sandboxed: no edits to the original artifact. | "What would you do if I told you the page actually loaded successfully?" — Matt's "fantasy land". |

Matt's ask is **A**, possibly extended to **C** later. **B** is a different
problem (harness self-test) and probably isn't worth building unless we see
specific need.

The mistake to avoid: trying to make A pay for B's overhead. B requires
recording tool outputs in a form that can be replayed deterministically;
A only needs to *reconstruct what the agent saw*, then ask it something new.

### Prior art

- Sakura Sky, "Trustworthy AI Agents: Deterministic Replay" — clearly
  articulates B and its requirements: seven mandatory trace fields (LLM I/O,
  tool I/O, decisions, model params, tool versions, timestamps, structured
  output). Warns that "silent fallback to live systems" during replay
  invalidates the whole exercise. Their cursor model — one cursor per event
  kind — is a clean primitive. **They don't address A or C explicitly.**
  Source: https://www.sakurasky.com/blog/missing-primitives-for-trustworthy-ai-part-8/
- AgentRR (arxiv 2505.17716) — closer to a *case-based-reasoning* system
  than what we want. They replay "generalized experiences" at varying
  abstraction levels rather than exact traces. Useful framing for thinking
  about what's worth recording (state vs. operations) but their approach
  doesn't map cleanly to Gauntlet's per-run debugging needs.
- LangSmith / Langfuse / OpenTelemetry-for-LLMs — generally support
  *viewing* traces; some support *re-running prompts* against new models.
  None of the popular ones, as of this writing, have a first-class
  "branch from turn N and chat" affordance the way Matt wants.

The interesting observation: **the most useful primitive (A) is the one the
prior-art bibliography talks about least**. The "deterministic replay" framing
dominates because it's the academically-interesting one; the practitioner
operation ("ask the agent why") is barely named.

---

## 2. What `run.jsonl` already gives us

Gauntlet's existing event log is most of the way to mode A. Reading
`src/evidence/logger.ts` and `src/agent/agent.ts`:

**Present and sufficient:**

- `run_start` — captures `runId`, `cardId`, `provider`, `model`, `adapter`,
  `budgetMs`, `reflectionInterval`, `toolTimeoutMs`, `viewport`. **Pins the
  model identity** for revival (mode A needs this to ask the right model).
- `system_prompt` — full content, written once.
- `user_message` — turn-numbered, content. Includes turn-0 initial message,
  reflection-checkpoint reminders, deadline-grace reminder.
- `llm_response` — turn, stopReason, text, thinking blocks (with
  signatures!), tool calls, usage, **`rawAssistantMessage`**. The raw
  assistant message is the key field — it carries the exact provider-shape
  the next request used.
- `tool_call` — turn, toolUseId, name, arguments.
- `tool_result` — turn, toolUseId, name, durationMs, text, image
  (relative path if spilled), artifact, capturePath, error.
- `eventId` + `parentEventId` form a linear chain, so we can identify
  "turn N" unambiguously by event id.

This is enough to **rebuild `messages[]` up to turn N** the way the agent
loop did originally:

1. Open `run.jsonl`, walk events until you pass the desired turn boundary.
2. `system_prompt.content` → systemPrompt string.
3. For each turn, in order:
   - Append `user_message` content as a `client.userMessage(...)`.
   - Append `llm_response.rawAssistantMessage` as the assistant turn (it's
     already in the provider's native shape — no conversion needed).
   - Build tool_result blocks from `tool_call` + `tool_result` rows for that
     turn and append them via `client.toolResultMessages(...)`.
4. Append a new user message ("Why did you click the cancel button on turn
   14?") to messages[].
5. Call `client.chat(messages, [], systemPrompt)` — empty tool list, single
   round.
6. Return the model's reply. Discard.

That's the read-only Q&A. No state mutates. No new run is created.

**Present but lossy:**

- Tool result images: `run.jsonl` logs the relative path
  (`screenshots/001.png`), not the inline base64. The original LLM saw
  the image; revival without re-feeding it sees only the path. For Q&A
  mode this is *often* acceptable (the question is usually about the
  agent's *decision*, not its perception of the pixels), but for any
  question that turns on what was on screen, fidelity drops.
- Large tool outputs spilled to `artifacts/N.txt`: the `text` field is
  empty, with `textTruncated: true` and a pointer. Same trade-off — the
  original agent saw the full text; revival can re-read from disk.

**Not present:**

- **Tool definitions schema.** The agent loop builds `tools` at runtime from
  `adapter.toolDefinitions()` plus `REPORT_TOOL`. The names of called tools
  are in `tool_call` events, but the *schemas* (JSON Schema for arguments)
  are not logged anywhere durable. This is the load-bearing gap.

  Why it matters: even mode A (single new question, no tools allowed)
  benefits from passing the same tool definitions to the model so its
  understanding of what's available matches the original run. If you ask
  "why did you call `click(selector='#save')` on turn 14?", the model
  reasons better when it can see that `click` was a tool it had access
  to with that signature. Passing zero tools changes the conversation
  shape in subtle ways.

  Two ways to close this:

  - **(a) Log tool defs at run_start.** Append a `tool_definitions` event
    at the top of `run.jsonl`, capturing the full `[adapter tools,
    REPORT_TOOL]` array. One-time cost, ~1–5KB per run. Forward-compatible.
  - **(b) Reconstruct from the adapter at revival time.** Cheaper to ship
    (zero log changes), but the schemas can drift if the adapter code
    changes between record and revival. We've already been bitten by
    schema drift elsewhere; deferring this to "just call the adapter
    again" makes revival silently lie about what the agent saw.

  **(a) is the correct fix.** The cost is trivial; the alternative is a
  bug class waiting to happen.

- **Provider-side request shape.** `llm_request` records only `turn` and
  `messageCount`. We don't capture the exact request body (max_tokens,
  cache breakpoints, etc.). For mode A this doesn't matter — we rebuild
  messages from raw assistant content, which is the authoritative thing
  the *next* turn consumed. For mode B (deterministic replay) it would
  matter.

---

## 3. Proposed mode A: read-only Q&A

A CLI command, callable by humans and Bobs:

```
gauntlet ask <runId> [--turn N]
```

Behavior:

1. Open the run directory under `.gauntlet/results/<runId>/`.
2. Read `run.jsonl`. Reconstruct `systemPrompt` and `messages[]` up to the
   end of turn N (or the end of the run if `--turn` is omitted).
3. Read `result.json` for context (`config.model`, `config.adapter`).
4. Reconstruct tool definitions: see §2's tool-defs gap. Until logged
   durably, fall back to `adapter.toolDefinitions()` for the adapter
   named in `result.json.config.adapter` and warn loudly that schemas may
   have drifted.
5. Drop into an interactive REPL: read a line from stdin, append as
   `client.userMessage(...)`, call `client.chat(messages, tools, systemPrompt)`
   with a **stubbed adapter** that refuses every tool call (returns an error
   asking the model to answer in plain text). Print the response text.
6. On exit, write nothing.

Notes on the REPL:
- Multi-turn within a single revival session is fine — each new user
  question extends `messages[]` in memory. We're not writing to disk.
- If the model attempts a tool call instead of answering, the stubbed
  adapter returns an error like "This is a read-only Q&A on a recorded
  run; tools are unavailable. Please answer in plain text." The model
  recovers on the next turn.
- An alternative is to just *not pass any tools*. This is simpler but
  loses the fidelity benefit described above. We can prototype both and
  see which gives better answers.

Model identity:
- Default to the model recorded at `run_start.model`. **Pinning this
  matters.** If the recorded model is `claude-sonnet-4-5` but the
  current default is `claude-sonnet-4-6`, asking 4-6 to explain 4-5's
  decision is not the same operation. Allow `--model` override for
  experiments, but mark the answer as "from a different model" in the
  output.

Bobs ask too. Surface the same primitive as a programmatic API the same
way `runAgent` is exposed — `askAgent(runId, opts)` returning an iterator
of model replies — so a coordinating Bob can interrogate a past run
without spawning a subagent. Out of scope for v1 but design the CLI
plumbing so it doesn't preclude this.

---

## 4. Counterfactual branch (mode C) — design hooks, don't build yet

If mode A is the floor, mode C is the fantasy. Don't ship until we know A
isn't already enough. But shape A so C is reachable:

- The "rebuild messages[] up to turn N" function should be the same code
  path for both modes. Mode A appends a user question and stops; mode C
  appends a user message and re-enters the agent loop with **live**
  tools, against a sandboxed adapter target.
- "Sandboxed" is the load-bearing word. The web adapter mutates real
  browsers. The TUI adapter mutates real tmux panes. Counterfactual
  branching that fires real tools at real targets is a footgun. Design
  C to require an explicit, isolated target (a fresh devbox, a fresh
  Chrome instance, a fresh tmux session) — never reuse the original
  run's target.
- Even with isolation, the original run's evidence directory must be
  **immutable** during branching. Write branch outputs to a sibling
  directory or to a tmpdir; never `appendFile` into the source
  `run.jsonl`.

There's a real cost to building C: it doubles the test surface (every
adapter has to support "fresh isolated instance"), and it tempts users
into thinking the agent's branched behavior is "what would have
happened" — when in reality it's "what this model, today, would do,
given the snapshot." Worth saying out loud in the docs.

---

## 5. Recommended next steps

1. **Add `tool_definitions` event to `run.jsonl` writers.** Cheap,
   forward-compatible, closes the only real gap for mode A. Bump
   `schemaVersion` only if a reader needs it — additive change should be
   fine.
2. **Write the spec** (Spec, not Plan — per the spec-before-plan
   discipline) for `gauntlet ask <runId> [--turn N]`. Spec covers the
   CLI shape, the messages-rebuild contract, the model-pinning policy,
   and the no-tools / stubbed-tools decision.
3. **Sign off on the spec before implementation.** Specifically:
   - Is the recorded-model default the right policy, or should the user
     have to opt in to "pin"?
   - Is "no tools at all" or "tools listed but rejected" the better
     fidelity choice for the read-only mode? (My guess: tools listed but
     rejected — closer to what the original agent saw.)
   - How much does the missing-image-bytes thing actually hurt in
     practice? Worth testing once we have an MVP.
4. **Prototype against a real recorded run.** Mode A's correctness is
   almost entirely empirical — does the model give useful answers when
   handed a reconstructed state? Five minutes of using the prototype
   will tell us more than another page of design.

---

## 6. Reusable takeaways (the "creative searching" digest)

For the next person (human or Bob) thinking about revivifying agent runs:

- **Don't conflate "replay" modes.** Snapshot Q&A, deterministic
  re-execution, and counterfactual branching are three different
  operations with three different fidelity bars. Name the one you mean.
- **The cheapest useful primitive is snapshot Q&A.** If your trace logs
  raw assistant messages and tool I/O (most do — Gauntlet does), Q&A is
  ~200 lines of code away. Build it first.
- **Log tool *definitions*, not just tool *calls*.** Tool calls tell you
  what the model picked; tool definitions tell you what it had to pick
  from. Without the latter, revival silently shows the model a
  different menu than the original run saw.
- **Pin the model at record time.** Model identity changes the
  conversation. A revival against a different model is doing a
  different experiment and should be labeled as such.
- **Read-only revivals must never write back.** Open the artifact in
  write-locked mode if your filesystem supports it; at minimum, route
  all revival output to a sibling directory. Mutating the source
  trace during revival turns the trace into a moving target.
- **Image and large-text bytes are the lossy edges.** A revival pipeline
  that promises high fidelity needs a strategy for re-feeding them from
  disk. Mode A often tolerates this loss; mode C usually doesn't.
- **Counterfactual branching is more dangerous than it looks.** Live
  tools against real targets mean a "what-if" can ship real side
  effects. Force isolation; force immutability of the source artifact;
  document the "this is what *this* model *today* would do" caveat.
