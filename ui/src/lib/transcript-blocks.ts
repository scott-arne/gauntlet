import type { TranscriptModel, TranscriptEvent } from "./transcript";

export type Block =
  | { kind: "user_message"; eventId: number; turn: number; content: string; isReminder: boolean }
  | { kind: "turn"; turn: number }
  | { kind: "anomaly"; eventId: number };

const SYSTEM_REMINDER_PREFIX = /^\s*<SYSTEM-REMINDER>/;

export function isSystemReminder(content: string): boolean {
  return SYSTEM_REMINDER_PREFIX.test(content);
}

// Walk model.ordered chronologically and emit one block per render slot.
//
// - user_message events render inline where they appear in the stream.
//   Initial prompts (turn 0) land at the top because the server logs them
//   before any turn events; reflection/grace reminders land between the
//   turns whose events bracket them. We do NOT interpret event.turn
//   semantically — chronology is the source of truth for position.
// - Each turn renders a single TurnBlock the first time we see an event
//   for it (preserves prior Transcript.tsx behavior).
// - Anomaly events render inline.
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
