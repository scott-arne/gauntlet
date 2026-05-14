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

// Render order is computed by `buildBlocks` (see ../lib/transcript-blocks.ts)
// which walks model.ordered chronologically. user_message events render
// inline where they appear in the stream — so the initial prompt lands at
// the top (logged before any turn events) and reflection / grace reminders
// land between the turns that bracket them.
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
