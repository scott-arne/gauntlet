# PRI-1495 — Render system-reminder messages at the turn they fired

**Status:** Spec, revised after review by Bashir@1e23ce40
**Author:** Mosscap@1fce163d
**Linear:** https://linear.app/prime-radiant/issue/PRI-1495

## Problem

In the Transcript view, system-reminder messages appear pinned at the top of
the transcript, immediately under the system prompt. They look like part of the
opening context. They are not. They are injected into the conversation at a
specific later turn — typically a reflection checkpoint between turns, or the
final grace-turn deadline reminder — and the position misleads the reader about
when the model actually saw them.

## Root cause

The Transcript data model has a single `userMessage` slot:

```ts
// ui/src/lib/transcript.ts
export interface TranscriptModel {
  // …
  userMessage?: UserMessageEvent;
}
```

The reducer assigns to it on every `user_message` event:

```ts
case "user_message":
  return { ...model, ordered, maxEventId, userMessage: event };
```

Last write wins. The renderer reads that single slot once, at the top:

```tsx
// ui/src/components/transcript/Transcript.tsx
{model.systemPrompt && <SystemPromptPanel content={model.systemPrompt.content} />}
{model.userMessage && <UserMessagePanel content={model.userMessage.content} />}
{blocks}
```

Meanwhile the server emits `user_message` events at three distinct moments,
each with a different relationship between `event.turn` and the turn that
*consumes* the message:

| Site | `event.turn` | Consumed by `llm_request` of turn | Notes |
|---|---|---|---|
| `src/agent/agent.ts:167` | 0 | 1 | Initial prompt; turn=0 is a "before any turn" sentinel |
| `src/agent/agent.ts:403` | N (the turn whose response triggered the reminder) | N+1 | Reflection checkpoint |
| `src/agent/agent.ts:458` | graceTurn (= turns + 1) | graceTurn | Final deadline reminder |

So `event.turn` does **not** consistently mean "the turn that consumes this
message." Three callsites, three numbering conventions. We don't fix that
server-side in this ticket — the convention churn would touch revival, replay,
and fixtures for a UI display concern. The UI fix is to stop *interpreting*
`event.turn` and render by chronology instead.

## Acceptance (from the ticket, restated)

1. A user_message logged at turn N renders inline at turn N — not adjacent to
   the system prompt.
2. The initial user prompt (turn 0) continues to render at the top of the
   transcript, where it belongs.
3. A user_message whose content begins with `<SYSTEM-REMINDER>` is visually
   distinguishable from regular user input — readers can see at a glance that
   it's a system injection, not human input.

## Design

### Model change

Replace the single slot with a turn-keyed map:

```ts
export interface TranscriptModel {
  // …
  userMessages: Map<number, UserMessageEvent>;  // event.turn → event
  // userMessage?: UserMessageEvent;             // removed
}
```

Reducer:

```ts
case "user_message": {
  const userMessages = new Map(model.userMessages);
  userMessages.set(event.turn, event);
  return { ...model, ordered, maxEventId, userMessages };
}
```

Map keyed by `event.turn` because that field is the message's natural primary
key — the only handle a non-render consumer (a test, a debugger) has to ask
"what was injected at the reflection checkpoint after turn N?". Render order
does *not* depend on this Map (see below).

The per-turn `TurnModel` is **not** extended with a `userMessage` field — the
event-turn convention is inconsistent across the three emit sites (see table
above), so there's no single TurnModel that can naturally claim ownership.
Top-level Map keeps that mismatch from leaking into the per-turn shape.

### Render change

The render walk treats `user_message` events as first-class members of the
chronological event stream — not as a single slot. The current walk skips them
(only `llm_request`/`llm_response`/`tool_call`/`tool_result` are recognized as
"turn events"); the fix adds `user_message` as a third inline-emitting kind:

```tsx
for (const ev of model.ordered) {
  if (ev.type === "user_message") {
    blocks.push(<UserMessagePanel … />);     // or SystemReminderPanel — see below
  } else if (isTurnEvent(ev)) {
    /* existing TurnBlock emit, unchanged */
  } else if (ev.type === "event") {
    /* existing EventLine emit, unchanged */
  }
}
```

The current top-level `<UserMessagePanel content={model.userMessage.content} />`
between `SystemPromptPanel` and `{blocks}` goes away. The initial user message
(turn 0) is emitted by the server *before* any turn events — chronological
order alone places it at the top of `blocks`, immediately after the system
prompt. Visual position is unchanged for the existing turn-0 case; reflection
and grace reminders now appear inline, between the turn that produced them and
the turn that consumed them.

This makes the trigger-vs-consuming ambiguity moot. We don't need to decide
which turn the reminder "belongs" to — chronology already places it in the
right gap.

### Visual distinction

A user_message whose content matches `/^\s*<SYSTEM-REMINDER>/` renders with a
`SystemReminderPanel` instead of `UserMessagePanel`:

- Label: `system reminder · turn N` (lowercase, mono, slate — matches the
  existing system-prompt label register)
- Left rule: dashed or amber instead of teal (teal is reserved for human user
  input)
- Body: same italic display font as the user panel (it's still a user-role
  message in the conversation), but the wrapper makes the provenance obvious

Non-`<SYSTEM-REMINDER>` mid-run user_messages (none exist today, but the data
model allows them) fall back to the standard `UserMessagePanel` — just one
that happens to render mid-stream. No special case beyond pattern-matching
the prefix.

**Regex coupling guard.** The string `<SYSTEM-REMINDER>` is generated in two
places server-side:
- `src/agent/reflection.ts:60` (`buildReflectionReminder`)
- `src/agent/agent.ts:443` (inline grace-turn literal)

If either site changes the prefix (case, whitespace, surrounding markup), the
UI silently downgrades the reminder to a regular `UserMessagePanel` with no
test failure. To close the silent-failure window, add a server-side test that
asserts both reminder builders emit content matching the UI's regex. See
Tests §4.

## Out of scope

- **Reordering across roles.** This spec doesn't touch how assistant text,
  thinking, or tool calls are positioned within a turn block. Only user_message
  positioning is wrong; everything else is fine.
- **Server-side event taxonomy.** We don't add a new `system_reminder` event
  type. The pattern-match on `<SYSTEM-REMINDER>` is the source of truth for
  visual distinction. Reasoning: changing the server event taxonomy churns
  every consumer (logger, replay, revival, fixtures) for a UI-only display
  concern. If a future need argues for a typed boundary, that's a separate
  ticket.
- **Reflection-checkpoint trace contents.** The `<SYSTEM-REMINDER>` body is
  emitted by `src/agent/reflection.ts` and `src/agent/agent.ts` — unchanged.

## Tests

`test/ui/transcript.test.ts` currently fixtures one run (`login-matt-001`) with
a single user_message at turn 0. Add coverage:

1. **Reducer: multiple user_messages at different turns** — synthesize events
   directly (no fixture needed): `user_message` at turn 0 (initial), `user_message`
   at turn 4 (reflection-style `<SYSTEM-REMINDER>` body), `user_message` at turn 9
   (grace-style). Assert `model.userMessages.size === 3` and each is retrievable
   by its turn.

2. **Reducer: existing fixture unchanged** — run the existing `login-matt-001`
   fixture through the new reducer; the only `user_message` event has turn 0,
   so `userMessages.size === 1` and `userMessages.get(0)?.content` matches the
   prior `userMessage?.content`. Update the existing assertion at
   `test/ui/transcript.test.ts:57` (`model.userMessage?.turn`) to read from the
   Map.

3. **Render: chronological placement** — assert the rendered block sequence on
   a synthesized stream:
   - **3a Initial-only:** turn-0 user_message + turns 1-2 → first block is the
     UserMessagePanel for turn 0, then TurnBlock(1), TurnBlock(2). (Covers
     acceptance #2: turn-0 prompt still at the top.)
   - **3b Reflection inline:** turns 1-3 + reflection user_message logged after
     turn-3 events + turn-4 events → block order is TurnBlock(1), TurnBlock(2),
     TurnBlock(3), SystemReminderPanel, TurnBlock(4). (Covers acceptance #1.)
   - **3c Grace inline:** loop turns + grace user_message + grace turn events
     → SystemReminderPanel renders *before* the grace TurnBlock, not at the
     bottom or with the prior turn.

   If a DOM render harness doesn't exist for `ui/src`, assert against the
   block array `Transcript` produces (extract the walk into a pure helper and
   test it directly).

4. **Reminder-prefix coupling guard (server-side)** — in
   `test/agent/reflection.test.ts` (or sibling), assert
   `buildReflectionReminder(traceText)` and the grace-turn literal at
   `agent.ts:443` both produce strings matching the UI regex
   `/^\s*<SYSTEM-REMINDER>/`. The test reads both values via the source-of-
   truth callsites — not duplicated string constants — so it actually breaks
   if someone re-words the prefix.

5. **Snapshot guard on the existing happy path** — render the `login-matt-001`
   fixture through `Transcript` (or its pure walk helper) and snapshot the
   block sequence. This is the regression-on-the-happy-path guard: the change
   should produce zero visual difference for runs without checkpoints.

## Migration

The model field renames from `userMessage?` to `userMessages: Map<number, UserMessageEvent>`.
Known consumers in the tree:

- `ui/src/components/transcript/Transcript.tsx:62` — read in render. Removed
  in this change (rendering moves into the walk).
- `test/ui/transcript.test.ts:57` — `model.userMessage?.turn` assertion.
  Updated to `model.userMessages.get(0)?.turn`.

Implementation: re-grep `model.userMessage` before merge to catch anything new
that landed in parallel (worktrees in `.claude/worktrees/` may carry their own
copies).

No on-disk format change. `run.jsonl` already carries `turn` on every
`user_message` event; this fix just stops throwing it away.

## Risks

- **No render-test harness exists for `ui/src` today** (no `*.test.ts*` under
  `ui/src` or `test/ui/` beyond the reducer tests). Plan-time decision: extract
  the block-emit walk from `Transcript.tsx` into a pure helper (`buildBlocks`
  or similar) so test 3 can assert against an array of `{type, turn?, kind?}`
  descriptors without spinning up a DOM. Cheaper than adding a render-test
  framework for one bug fix; equally tight as a regression guard.
- **Fixture coverage is thin** — only one fixture, and it has no checkpoints.
  Synthesized events are sufficient for this fix. A captured-with-checkpoints
  fixture would be nice eventually, but it's not load-bearing for acceptance.
