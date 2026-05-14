# PRI-1495 System-Reminder Positioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render mid-run `<SYSTEM-REMINDER>` user messages inline at the chronological point they fired, instead of pinning them under the system prompt.

**Architecture:** Replace the single `userMessage?` slot on `TranscriptModel` with a `userMessages: Map<turn, UserMessageEvent>`. Move user-message rendering from a top-level slot read into the chronological `model.ordered` walk in `Transcript.tsx`. Pattern-match `<SYSTEM-REMINDER>` prefix to switch the panel component. Add a server-side test pinning the prefix string against the UI regex.

**Tech Stack:** TypeScript / React 18 / Bun test runner. UI lives in `ui/src/`, agent in `src/agent/`, tests in `test/`.

**Spec:** `docs/superpowers/specs/2026-05-13-pri-1495-system-reminder-positioning-spec.md`

---

## Task 0: Branch + verify clean state

**Files:**
- N/A (git only)

- [ ] **Step 1: Verify on main with no relevant uncommitted changes**

```bash
git branch --show-current
git status --short
```

Expected: branch=`main`, only the pre-existing untracked files (`TODO`, `.TODO.swp`, `docs/notes/.embeddings/`, `y`, the spec + plan files) and no modified tracked files.

- [ ] **Step 2: Create feature branch**

```bash
git checkout -b matt/pri-1495-transcript-system-reminder-positioning
```

(Branch name from `gitBranchName` on the Linear ticket, slightly shortened.)

- [ ] **Step 3: Commit the spec + plan**

```bash
git add docs/superpowers/specs/2026-05-13-pri-1495-system-reminder-positioning-spec.md \
        docs/superpowers/plans/2026-05-13-pri-1495-system-reminder-positioning.md
git commit -m "$(cat <<'EOF'
docs(pri-1495): spec + plan for system-reminder turn positioning

Co-Authored-By: Mosscap@1fce163d (Opus 4.7)
EOF
)"
```

---

## Task 1: Reducer — replace `userMessage?` slot with `userMessages` Map

**Files:**
- Modify: `ui/src/lib/transcript.ts` (the `TranscriptModel` interface, `emptyTranscript()`, `applyEvent()` `user_message` branch)
- Modify: `test/ui/transcript.test.ts:57` (existing assertion — see Step 5)
- Test: `test/ui/transcript.test.ts` (add new test cases)

- [ ] **Step 1: Write failing reducer tests**

Add these tests to `test/ui/transcript.test.ts` inside the existing `describe("reduceTranscript", …)` block, after the existing tests:

```ts
test("multiple user_messages at different turns are kept by turn key", () => {
  // Synthetic events — no fixture needed. Mirror the three real callsites
  // (initial / reflection / grace).
  const evs: TranscriptEvent[] = [
    { eventId: 1, parentEventId: 0, ts: "t1", type: "user_message", turn: 0, content: "initial prompt" },
    { eventId: 2, parentEventId: 0, ts: "t2", type: "user_message", turn: 4, content: "<SYSTEM-REMINDER>\nReflection checkpoint." },
    { eventId: 3, parentEventId: 0, ts: "t3", type: "user_message", turn: 9, content: "<SYSTEM-REMINDER>\nYou have used your time budget" },
  ];
  const model = reduceTranscript(evs);
  expect(model.userMessages.size).toBe(3);
  expect(model.userMessages.get(0)?.content).toBe("initial prompt");
  expect(model.userMessages.get(4)?.content.startsWith("<SYSTEM-REMINDER>")).toBe(true);
  expect(model.userMessages.get(9)?.content.startsWith("<SYSTEM-REMINDER>")).toBe(true);
});
```

Also update the existing fixture assertion at `test/ui/transcript.test.ts:57` from:

```ts
    expect(model.userMessage?.turn).toBe(0);
```

to:

```ts
    expect(model.userMessages.size).toBe(1);
    expect(model.userMessages.get(0)?.turn).toBe(0);
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/ui/transcript.test.ts
```

Expected: FAIL — `model.userMessages` is `undefined` (property doesn't exist) on the new test, and the updated fixture test fails the same way.

- [ ] **Step 3: Update `TranscriptModel` and reducer**

In `ui/src/lib/transcript.ts`, change the interface (around lines 135-145):

```ts
export interface TranscriptModel {
  runId?: string;
  runStart?: RunStartEvent;
  systemPrompt?: SystemPromptEvent;
  userMessages: Map<number, UserMessageEvent>;
  turns: Map<number, TurnModel>;
  runEnd?: RunEndEvent;
  anomalies: AnomalyEvent[];
  ordered: TranscriptEvent[];
  maxEventId: number;
}
```

(The `userMessage?: UserMessageEvent` line is removed. `userMessages` is non-optional like `turns` is — empty Map by default.)

Update `emptyTranscript()` (around line 147):

```ts
export function emptyTranscript(): TranscriptModel {
  return {
    userMessages: new Map(),
    turns: new Map(),
    anomalies: [],
    ordered: [],
    maxEventId: 0,
  };
}
```

Update the `user_message` branch in `applyEvent()` (around line 197):

```ts
    case "user_message": {
      const userMessages = new Map(model.userMessages);
      userMessages.set(event.turn, event);
      return { ...model, ordered, maxEventId, userMessages };
    }
```

- [ ] **Step 4: Run reducer tests to verify they pass**

```bash
bun test test/ui/transcript.test.ts
```

Expected: PASS, all tests in the file. (Note: `Transcript.tsx` will be temporarily broken at the type level — fixed in Task 3. Don't run `typecheck:ui` yet.)

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/transcript.ts test/ui/transcript.test.ts
git commit -m "$(cat <<'EOF'
fix(ui): track all user_messages by turn, not just the last (PRI-1495)

The single userMessage slot on TranscriptModel was overwritten on every
user_message event, so mid-run reflection-checkpoint reminders clobbered
the initial prompt. Replace with a Map keyed by event.turn. Render code
update follows in the next commit.

Co-Authored-By: Mosscap@1fce163d (Opus 4.7)
EOF
)"
```

---

## Task 2: Extract pure block-build helper from `Transcript.tsx`

Goal: a pure function that takes the model and returns a list of block descriptors, so render order is unit-testable without a DOM.

**Files:**
- Create: `ui/src/lib/transcript-blocks.ts`
- Test: `test/ui/transcript-blocks.test.ts`

- [ ] **Step 1: Write failing tests for the block-build helper**

Create `test/ui/transcript-blocks.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import {
  emptyTranscript,
  applyEvent,
  type TranscriptEvent,
} from "../../ui/src/lib/transcript";
import { buildBlocks } from "../../ui/src/lib/transcript-blocks";

function reduce(evs: TranscriptEvent[]) {
  return evs.reduce(applyEvent, emptyTranscript());
}

const baseTurnEvents = (turn: number, eventIdStart: number): TranscriptEvent[] => [
  { eventId: eventIdStart,     parentEventId: 0, ts: `t${eventIdStart}`,   type: "llm_request",  turn, messageCount: 1 },
  { eventId: eventIdStart + 1, parentEventId: 0, ts: `t${eventIdStart+1}`, type: "llm_response", turn, stopReason: "end_turn", text: "", thinking: [], toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, rawAssistantMessage: null },
];

describe("buildBlocks", () => {
  test("3a — initial-only: turn-0 user_message before turn blocks", () => {
    const model = reduce([
      { eventId: 1, parentEventId: 0, ts: "t1", type: "user_message", turn: 0, content: "go" },
      ...baseTurnEvents(1, 2),
      ...baseTurnEvents(2, 4),
    ]);
    const blocks = buildBlocks(model);
    expect(blocks.map((b) => b.kind)).toEqual(["user_message", "turn", "turn"]);
    expect(blocks[0]).toMatchObject({ kind: "user_message", turn: 0, isReminder: false });
    expect(blocks[1]).toMatchObject({ kind: "turn", turn: 1 });
    expect(blocks[2]).toMatchObject({ kind: "turn", turn: 2 });
  });

  test("3b — reflection inline: reminder between turn 3 and turn 4", () => {
    // Reflection fires after turn N's tool_results — so the user_message
    // event has eventId greater than turn-3 events and less than turn-4 events.
    // event.turn carries the *trigger* turn (3).
    const model = reduce([
      { eventId: 1, parentEventId: 0, ts: "t1", type: "user_message", turn: 0, content: "go" },
      ...baseTurnEvents(1, 2),
      ...baseTurnEvents(2, 4),
      ...baseTurnEvents(3, 6),
      { eventId: 8, parentEventId: 0, ts: "t8", type: "user_message", turn: 3, content: "<SYSTEM-REMINDER>\nReflection checkpoint." },
      ...baseTurnEvents(4, 9),
    ]);
    const blocks = buildBlocks(model);
    expect(blocks.map((b) => b.kind)).toEqual([
      "user_message", // initial turn-0
      "turn",         // 1
      "turn",         // 2
      "turn",         // 3
      "user_message", // reminder
      "turn",         // 4
    ]);
    expect(blocks[4]).toMatchObject({ kind: "user_message", turn: 3, isReminder: true });
  });

  test("3c — grace inline: reminder before grace TurnBlock", () => {
    // Grace turn: the user_message event has event.turn = graceTurn,
    // logged immediately before the grace llm_request (same turn number).
    const model = reduce([
      { eventId: 1, parentEventId: 0, ts: "t1", type: "user_message", turn: 0, content: "go" },
      ...baseTurnEvents(1, 2),
      { eventId: 4, parentEventId: 0, ts: "t4", type: "user_message", turn: 2, content: "<SYSTEM-REMINDER>\nYou have used your time budget" },
      ...baseTurnEvents(2, 5),
    ]);
    const blocks = buildBlocks(model);
    expect(blocks.map((b) => b.kind)).toEqual(["user_message", "turn", "user_message", "turn"]);
    expect(blocks[2]).toMatchObject({ kind: "user_message", turn: 2, isReminder: true });
    expect(blocks[3]).toMatchObject({ kind: "turn", turn: 2 });
  });

  test("recognizes <SYSTEM-REMINDER> prefix with optional leading whitespace", () => {
    const model = reduce([
      { eventId: 1, parentEventId: 0, ts: "t1", type: "user_message", turn: 0, content: "  \n<SYSTEM-REMINDER>\nbody" },
    ]);
    const blocks = buildBlocks(model);
    expect(blocks[0]).toMatchObject({ kind: "user_message", isReminder: true });
  });

  test("does NOT mark plain user content as reminder", () => {
    const model = reduce([
      { eventId: 1, parentEventId: 0, ts: "t1", type: "user_message", turn: 0, content: "Verify the login flow" },
    ]);
    const blocks = buildBlocks(model);
    expect(blocks[0]).toMatchObject({ kind: "user_message", isReminder: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/ui/transcript-blocks.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the helper**

Create `ui/src/lib/transcript-blocks.ts`:

```ts
import type { TranscriptModel, TranscriptEvent } from "./transcript";

export type Block =
  | { kind: "user_message"; eventId: number; turn: number; content: string; isReminder: boolean }
  | { kind: "turn"; turn: number }
  | { kind: "anomaly"; eventId: number };

const SYSTEM_REMINDER_PREFIX = /^\s*<SYSTEM-REMINDER>/;

export function isSystemReminder(content: string): boolean {
  return SYSTEM_REMINDER_PREFIX.test(content);
}

/**
 * Walk model.ordered chronologically and emit one block per render slot.
 *
 * - user_message events render inline where they appear in the stream.
 *   Initial prompts (turn 0) land at the top because the server logs them
 *   before any turn events; reflection / grace reminders land between the
 *   turns whose events bracket them. We do NOT interpret event.turn
 *   semantically — chronology is the source of truth for position.
 * - Each turn renders a single TurnBlock the first time we see an event
 *   for it (matches the prior Transcript.tsx behavior).
 * - Anomaly events render inline.
 */
export function buildBlocks(model: TranscriptModel): Block[] {
  const blocks: Block[] = [];
  const renderedTurns = new Set<number>();
  for (const ev of model.ordered) {
    if (ev.type === "user_message") {
      blocks.push({
        kind: "user_message",
        eventId: ev.eventId,
        turn: ev.turn,
        content: ev.content,
        isReminder: isSystemReminder(ev.content),
      });
    } else if (isTurnEvent(ev)) {
      if (renderedTurns.has(ev.turn)) continue;
      renderedTurns.add(ev.turn);
      blocks.push({ kind: "turn", turn: ev.turn });
    } else if (ev.type === "event") {
      blocks.push({ kind: "anomaly", eventId: ev.eventId });
    }
  }
  return blocks;
}

function isTurnEvent(
  ev: TranscriptEvent,
): ev is Extract<TranscriptEvent, { turn: number }> {
  return (
    ev.type === "llm_request" ||
    ev.type === "llm_response" ||
    ev.type === "tool_call" ||
    ev.type === "tool_result"
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/ui/transcript-blocks.test.ts
```

Expected: PASS — all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/transcript-blocks.ts test/ui/transcript-blocks.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): pure block-build helper for transcript render order (PRI-1495)

Extracts the chronological event walk from Transcript.tsx into a
testable pure function so render-order regressions can be caught
without a DOM harness. Recognizes the <SYSTEM-REMINDER> prefix.

Co-Authored-By: Mosscap@1fce163d (Opus 4.7)
EOF
)"
```

---

## Task 3: `SystemReminderPanel` component + CSS

**Files:**
- Create: `ui/src/components/transcript/SystemReminderPanel.tsx`
- Modify: `ui/src/styles/transcript.css` (add new selector block under the existing user-message block)

- [ ] **Step 1: Create the component**

Create `ui/src/components/transcript/SystemReminderPanel.tsx`:

```tsx
interface Props {
  turn: number;
  content: string;
}

export function SystemReminderPanel({ turn, content }: Props) {
  return (
    <div className="tr-system-reminder">
      <div className="tr-system-reminder-label">system reminder · turn {turn}</div>
      <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{content}</p>
    </div>
  );
}
```

- [ ] **Step 2: Add CSS**

Append to `ui/src/styles/transcript.css`, after the existing `.tr-user-message-label` block (around line 165):

```css
/* ============================================================
   System reminder — mid-run user-role injection (reflection /
   deadline). Same italic body as user-message but amber dashed
   left rule + lowercase mono label so the provenance is obvious.
   ============================================================ */

.tr-system-reminder {
  border-left: 3px dashed var(--tr-amber, #b6843b);
  padding: 6px 0 6px 20px;
  margin: 16px 0 8px;
  font-family: var(--tr-font-display);
  font-style: italic;
  font-size: 16px;
  color: var(--tr-ink-light);
  max-width: 68ch;
  line-height: 1.55;
}
.tr-system-reminder-label {
  font-family: var(--tr-font-mono);
  font-style: normal;
  font-size: 10px;
  font-weight: 500;
  text-transform: lowercase;
  letter-spacing: 0.04em;
  color: var(--tr-slate);
  margin-bottom: 4px;
  display: block;
}
```

(`--tr-amber` falls back to `#b6843b` if the variable isn't defined in the
palette. Worth checking in the manual verification step whether the palette
has an amber token to use directly.)

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/transcript/SystemReminderPanel.tsx ui/src/styles/transcript.css
git commit -m "$(cat <<'EOF'
feat(ui): SystemReminderPanel for inline mid-run reminders (PRI-1495)

Distinct visual treatment (amber dashed left rule, lowercase mono
label) so readers see at a glance that this is a system-injected
reminder, not human user input.

Co-Authored-By: Mosscap@1fce163d (Opus 4.7)
EOF
)"
```

---

## Task 4: Wire blocks into `Transcript.tsx`

**Files:**
- Modify: `ui/src/components/transcript/Transcript.tsx`

- [ ] **Step 1: Replace the render walk**

Open `ui/src/components/transcript/Transcript.tsx` and replace the entire body of the `Transcript` function (currently lines 29-67, including the inner `isTurnEvent` helper at the bottom) with:

```tsx
import type { Observation } from "./RunEndPanel";
import {
  computePromptPairings,
  findSoftErrors,
  type TranscriptModel,
} from "../../lib/transcript";
import { buildBlocks } from "../../lib/transcript-blocks";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { UserMessagePanel } from "./UserMessagePanel";
import { SystemReminderPanel } from "./SystemReminderPanel";
import { TurnBlock } from "./TurnBlock";
import { EventLine } from "./EventLine";
import { RunEndPanel } from "./RunEndPanel";
import { ErrorBanner } from "./ErrorBanner";

interface Props {
  runId: string;
  model: TranscriptModel;
  currentTurn: number | null;
  activeArtifact: string | null;
  onOpenArtifact: (path: string) => void;
  observations: Observation[];
}

export function Transcript({ runId, model, currentTurn, activeArtifact, onOpenArtifact, observations }: Props) {
  const promptPairings = computePromptPairings(model);
  const blocks = buildBlocks(model);
  const anomaliesById = new Map(model.anomalies.map((a) => [a.eventId, a]));

  const rendered = blocks.map((block) => {
    if (block.kind === "user_message") {
      if (block.isReminder) {
        return (
          <SystemReminderPanel
            key={`um-${block.eventId}`}
            turn={block.turn}
            content={block.content}
          />
        );
      }
      return <UserMessagePanel key={`um-${block.eventId}`} content={block.content} />;
    }
    if (block.kind === "turn") {
      const turn = model.turns.get(block.turn);
      if (!turn) return null;
      return (
        <TurnBlock
          key={`turn-${block.turn}`}
          runId={runId}
          turn={turn}
          isCurrent={currentTurn === block.turn}
          promptPairings={promptPairings}
          activeArtifact={activeArtifact}
          onOpenArtifact={onOpenArtifact}
        />
      );
    }
    // anomaly
    const ev = anomaliesById.get(block.eventId);
    if (!ev) return null;
    return <EventLine key={`evt-${block.eventId}`} event={ev} />;
  });

  const softErrors = findSoftErrors(model);

  return (
    <div className="tr-transcript">
      <ErrorBanner sites={softErrors} />
      {model.systemPrompt && <SystemPromptPanel content={model.systemPrompt.content} />}
      {rendered}
      {model.runEnd && <RunEndPanel runEnd={model.runEnd} observations={observations} />}
    </div>
  );
}
```

The key behavioral changes vs. the prior file:
- Top-level `<UserMessagePanel content={model.userMessage.content} />` is gone — the initial user message renders inline as the first block (the server logs turn-0 user_message before any turn event, so it lands first in chronological order).
- The walk now handles `user_message` events and uses `SystemReminderPanel` for `<SYSTEM-REMINDER>`-prefixed content.
- `isTurnEvent` and the local `for` loop are gone — `buildBlocks` does that work.

- [ ] **Step 2: Type-check and run all UI tests**

```bash
bun run typecheck:ui
bun test test/ui/
```

Expected: typecheck passes; all UI tests pass (the existing reducer tests, the new block-builder tests).

- [ ] **Step 3: Build the UI**

```bash
bun run build:ui
```

Expected: build succeeds. (The Gauntlet API server serves `ui/dist`, not Vite dev — see project memory `project_gauntlet_ui_dist_rebuild`. Without this step, browser changes won't appear.)

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/transcript/Transcript.tsx ui/dist
git commit -m "$(cat <<'EOF'
fix(ui): render mid-run system-reminders inline at their turn (PRI-1495)

Walks model.ordered chronologically via the new buildBlocks helper.
Initial user prompt still lands at the top (logged before any turn
events). Reflection-checkpoint and grace-turn reminders now appear
between the turns that produced and consumed them, with a distinct
SystemReminderPanel so readers can tell them apart from user input.

Co-Authored-By: Mosscap@1fce163d (Opus 4.7)
EOF
)"
```

---

## Task 5: Server-side regex coupling guard

Defense against silent UI downgrade if anyone re-words the `<SYSTEM-REMINDER>` prefix.

**Files:**
- Create: `test/agent/system-reminder-prefix.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/agent/system-reminder-prefix.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { buildReflectionReminder } from "../../src/agent/reflection";
import { isSystemReminder } from "../../ui/src/lib/transcript-blocks";

describe("system-reminder prefix coupling (PRI-1495)", () => {
  test("buildReflectionReminder() output matches the UI's reminder regex", () => {
    const out = buildReflectionReminder("  1. click(selector=\".btn\")");
    expect(isSystemReminder(out)).toBe(true);
  });

  test("the grace-turn reminder literal in agent.ts matches the UI's reminder regex", () => {
    // Source-of-truth read: scrape the literal directly from agent.ts so a
    // prefix change in either place breaks this test rather than silently
    // downgrading the UI render.
    const agentSrc = readFileSync(
      join(import.meta.dir, "..", "..", "src", "agent", "agent.ts"),
      "utf8",
    );
    // The grace-turn builder concatenates a few backtick-quoted lines
    // starting with `<SYSTEM-REMINDER>\n`. Match the opening prefix.
    expect(agentSrc).toMatch(/`<SYSTEM-REMINDER>\\n`/);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (it should — this is a guard, not a fix)**

```bash
bun test test/agent/system-reminder-prefix.test.ts
```

Expected: PASS. Both reminder builders today already emit `<SYSTEM-REMINDER>` as the first non-whitespace token, and `agent.ts:443` literal matches the `` `<SYSTEM-REMINDER>\n` `` source pattern.

If it fails: do **not** fix the source string; the test is asserting the contract that the UI relies on. Either the spec is wrong or the source genuinely changed — escalate.

- [ ] **Step 3: Commit**

```bash
git add test/agent/system-reminder-prefix.test.ts
git commit -m "$(cat <<'EOF'
test(agent): pin <SYSTEM-REMINDER> prefix against UI regex (PRI-1495)

The UI's SystemReminderPanel selection depends on user_message
content matching /^\s*<SYSTEM-REMINDER>/. If a future edit re-words
the prefix in reflection.ts or agent.ts, this test fails loudly
instead of letting the UI silently fall back to UserMessagePanel.

Co-Authored-By: Mosscap@1fce163d (Opus 4.7)
EOF
)"
```

---

## Task 6: Manual visual verification

**Files:**
- N/A (browser only)

- [ ] **Step 1: Run a Gauntlet card with reflection enabled (or use an existing run)**

Find or generate a `run.jsonl` that contains at least one `user_message` event with `turn > 0`:

```bash
# Look at existing runs first — many of the cards in the test corpus run
# with reflectionInterval > 0. Look under `runs/` for a run with at least
# one reflection_checkpoint event:
rg -l '"type":"reflection_checkpoint"' runs/ | head -5
# OR if no such run exists locally, run a card with reflection enabled:
#   bun run src/index.ts run <some-card-id> --reflection-interval 3
```

If no run exists, fall back to running any card with reflection: see CLI flags via `bun run src/index.ts run --help`.

- [ ] **Step 2: Start the API server**

```bash
bun run src/index.ts serve &
```

(Note the port from stdout — typically 3001 or 4000.)

- [ ] **Step 3: Open the run in the browser**

Open `http://localhost:<port>/` and navigate to the run with reflection events.

- [ ] **Step 4: Verify the three acceptance criteria visually**

- ✅ The `<SYSTEM-REMINDER>` panel appears *between* turns (e.g. between turn 3 and turn 4), **not** pinned under the system prompt.
- ✅ The initial user prompt still appears at the top, immediately under the system prompt panel.
- ✅ The reminder panel is visually distinct: amber dashed left rule + lowercase `system reminder · turn N` mono label, vs. the teal solid rule + uppercase `USER` label of the initial-prompt panel.

If any of these are off, file the deviation as a checklist item before moving on. **Do not** mark Task 6 complete with visual gaps unaddressed.

- [ ] **Step 5: Stop the server**

```bash
# Find the bun PID and kill it (or use `kill %1` if it's the only background job)
kill %1 2>/dev/null || true
```

- [ ] **Step 6: No commit needed for this task** — verification only.

---

## Task 7: Final checks + merge

**Files:**
- N/A (CI + git)

- [ ] **Step 1: Run the full check suite**

```bash
bun run check
```

Expected: all four substeps pass — `typecheck`, `typecheck:ui`, `build:ui`, `test`.

- [ ] **Step 2: Verify branch state**

```bash
git status --short
git log main..HEAD --oneline
```

Expected: clean working tree; commits visible in order: spec/plan, reducer, block-build helper, SystemReminderPanel, Transcript wiring, regex coupling test.

- [ ] **Step 3: Re-grep `model.userMessage` for stragglers**

```bash
rg "model\.userMessage(?!s)" --type ts --type tsx ui src test 2>/dev/null
```

Expected: no matches. (If there are matches, it means a parallel branch landed something while we were working — fix and amend the appropriate commit.)

- [ ] **Step 4: Merge to main with --no-ff**

(Per project memory `feedback_no_prs`: Prime Radiant skips PRs; merge feature branches into main with `--no-ff` and push, leave the branch alone.)

```bash
git checkout main
git pull --ff-only
git merge --no-ff matt/pri-1495-transcript-system-reminder-positioning
git push origin main
```

If `pull --ff-only` fails (main moved), resolve before merging — don't force.

- [ ] **Step 5: Move ticket to In Review + write reflective comment**

(Per `linear-ticket-lifecycle` skill — done by the agent via Linear MCP, not a shell command.)

Move PRI-1495 → In Review, then post a comment covering: what went smoothly, what was tricky (likely the trigger-vs-consuming turn ambiguity Bashir@1e23ce40 caught), how it felt, any reviewer flags (the regex coupling — emphasize that the guard test is the safety net).

---

## Self-Review

**Spec coverage check:**

| Spec section | Plan task |
|---|---|
| Model change (Map<turn, UserMessageEvent>) | Task 1 |
| Render change (chronological walk, inline emit) | Tasks 2 + 4 |
| Visual distinction (`SystemReminderPanel`) | Task 3 |
| Regex coupling guard | Task 5 |
| Tests 1 + 2 (reducer) | Task 1 |
| Test 3a (initial-only render) | Task 2 |
| Test 3b (reflection inline) | Task 2 |
| Test 3c (grace inline) | Task 2 |
| Test 4 (server-side regex pin) | Task 5 |
| Test 5 (existing fixture snapshot) | Implicit in Task 1 step 1 — the existing fixture test continues to assert the same content, just via the Map key. A separate snapshot of the *block sequence* for the fixture would be belt-and-suspenders; deferring as it adds little signal beyond what tests 3a + the existing reducer test already cover. |
| Migration | Task 1 (covers the two known sites) + Task 7 step 3 (re-grep guard) |
| Risks (no render harness) | Task 2 (the buildBlocks extraction is the resolution) |

**Placeholder scan:** No "TBD"s, no "fill in details", every code step shows the code, every test step shows the assertions.

**Type consistency:** `Block` discriminated union uses `kind` consistently. `buildBlocks` signature stable across Tasks 2 and 4. `SystemReminderPanel` props (`turn`, `content`) stable across Tasks 3 and 4. `isSystemReminder` exported from `transcript-blocks` and consumed in Task 5.
