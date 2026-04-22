import { isSoftErrorResult, type TurnModel } from "../../lib/transcript";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolPairCard } from "./ToolPairCard";

interface Props {
  runId: string;
  turn: TurnModel;
  isCurrent: boolean;
  activeArtifact: string | null;
  onOpenArtifact: (path: string) => void;
}

function turnDuration(turn: TurnModel): string {
  const req = turn.llmRequest?.ts;
  const res = turn.llmResponse?.ts;
  if (!req || !res) return "";
  const ms = Date.parse(res) - Date.parse(req);
  if (isNaN(ms) || ms <= 0) return "";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatUsage(turn: TurnModel): string {
  const u = turn.llmResponse?.usage;
  if (!u) return "";
  return `${u.inputTokens.toLocaleString()} in · ${u.outputTokens.toLocaleString()} out`;
}

export function TurnBlock({ runId, turn, isCurrent, activeArtifact, onOpenArtifact }: Props) {
  const duration = turnDuration(turn);
  const usage = formatUsage(turn);
  const thinking = turn.llmResponse?.thinking ?? [];
  const text = turn.llmResponse?.text?.trim() ?? "";
  const softErrorCount = turn.tools.filter((p) => isSoftErrorResult(p.result)).length;

  return (
    <section id={`turn-${turn.turn}`} className={`tr-turn${isCurrent ? " tr-current" : ""}`}>
      <header>
        <div className="tr-turn-marker">Turn {turn.turn}</div>
        <div className="tr-turn-timing">
          {duration && <span>{duration}</span>}
          {duration && usage && <span> · </span>}
          {usage && <span>{usage}</span>}
          {softErrorCount > 0 && (
            <>
              <span> · </span>
              <span className="tr-turn-warn">
                {softErrorCount} recoverable error{softErrorCount === 1 ? "" : "s"}
              </span>
            </>
          )}
        </div>
      </header>

      {thinking.map((t, i) => (
        <ThinkingBlock key={`think-${i}`} text={t.text} />
      ))}

      {text && (
        <p className="tr-assistant-text" style={{ whiteSpace: "pre-wrap" }}>{text}</p>
      )}

      {turn.tools.map((pair) => (
        <ToolPairCard
          key={pair.toolUseId}
          runId={runId}
          pair={pair}
          activeArtifact={activeArtifact}
          onOpenArtifact={onOpenArtifact}
        />
      ))}
    </section>
  );
}
