import type { Observation } from "./RunEndPanel";
import { findSoftErrors, type TranscriptEvent, type TranscriptModel } from "../../lib/transcript";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { UserMessagePanel } from "./UserMessagePanel";
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

// Walk `model.ordered` chronologically. The first time we see an event for a
// given turn, render the whole TurnBlock for that turn (the model has all of
// that turn's events attached by now because we reduce left-to-right). Anomaly
// events render inline where they appear. `run_start`, `system_prompt`,
// `user_message`, `run_end` are rendered outside this walk.
export function Transcript({ runId, model, currentTurn, activeArtifact, onOpenArtifact, observations }: Props) {
  const renderedTurns = new Set<number>();
  const blocks: React.ReactNode[] = [];

  for (const ev of model.ordered) {
    if (isTurnEvent(ev)) {
      if (renderedTurns.has(ev.turn)) continue;
      renderedTurns.add(ev.turn);
      const turn = model.turns.get(ev.turn);
      if (!turn) continue;
      blocks.push(
        <TurnBlock
          key={`turn-${ev.turn}`}
          runId={runId}
          turn={turn}
          isCurrent={currentTurn === ev.turn}
          activeArtifact={activeArtifact}
          onOpenArtifact={onOpenArtifact}
        />,
      );
    } else if (ev.type === "event") {
      blocks.push(<EventLine key={`evt-${ev.eventId}`} event={ev} />);
    }
  }

  const softErrors = findSoftErrors(model);

  return (
    <div className="tr-transcript">
      <ErrorBanner sites={softErrors} />
      {model.systemPrompt && <SystemPromptPanel content={model.systemPrompt.content} />}
      {model.userMessage && <UserMessagePanel content={model.userMessage.content} />}
      {blocks}
      {model.runEnd && <RunEndPanel runEnd={model.runEnd} observations={observations} />}
    </div>
  );
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
