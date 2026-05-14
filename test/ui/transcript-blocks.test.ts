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
  { eventId: eventIdStart + 1, parentEventId: 0, ts: `t${eventIdStart + 1}`, type: "llm_response", turn, stopReason: "end_turn", text: "", thinking: [], toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, rawAssistantMessage: null },
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
    // event has eventId greater than turn-3 events and less than turn-4
    // events. event.turn carries the *trigger* turn (3).
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
