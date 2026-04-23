import { useState } from "react";
import { isSoftErrorResult, type ToolPair } from "../../lib/transcript";
import { Screenshot } from "./Screenshot";
import { ArtifactChip } from "./ArtifactChip";
import { TuiCapture } from "./TuiCapture";

interface Props {
  runId: string;
  pair: ToolPair;
  activeArtifact: string | null;
  onOpenArtifact: (path: string) => void;
}

const INLINE_CHARS = 1200;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function shortId(id: string): string {
  const tail = id.split("_").pop() ?? id;
  return tail.slice(0, 8);
}

// Tool_result rows for the TUI `read_screen` tool carry the capture path
// in the `text` field (e.g. `captures/003.ansi`) — not the inline ANSI.
// Detect that shape so the card renders the grid viewer instead of the
// path as raw text.
function isTuiCaptureResult(pair: ToolPair): string | null {
  if (pair.call.name !== "read_screen") return null;
  const text = pair.result?.text ?? "";
  if (/^captures\/\d+\.ansi$/.test(text)) return text;
  return null;
}

export function ToolPairCard({ runId, pair, activeArtifact, onOpenArtifact }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { call, result } = pair;
  const isError = result?.error === true;
  const isSoftError = isSoftErrorResult(result);
  const running = !result;
  const capturePath = isTuiCaptureResult(pair);

  const argsText = JSON.stringify(call.arguments, null, 2);

  const text = result?.text ?? "";
  const tooLong = text.length > INLINE_CHARS;
  const shownText = expanded || !tooLong ? text : text.slice(0, INLINE_CHARS) + "…";

  return (
    <div className={`tr-tool${isError ? " tr-error" : ""}${isSoftError ? " tr-warn" : ""}`}>
      <div className="tr-tool-head">
        <span className="tr-tool-name">{call.name}</span>
        <span className="tr-tool-id" title={call.toolUseId}>
          {shortId(call.toolUseId)}
        </span>
        {result && (
          <span className="tr-tool-duration">{formatDuration(result.durationMs)}</span>
        )}
        {running && <span className="tr-tool-flag">running…</span>}
        {isError && <span className="tr-tool-flag">error</span>}
        {isSoftError && !isError && (
          <span className="tr-tool-flag tr-tool-flag-warn" title="Tool succeeded but returned an error message. The agent likely spent extra turns recovering.">recoverable</span>
        )}
      </div>
      <div className="tr-tool-body">
        {argsText && argsText !== "{}" && (
          <>
            <div className="tr-tool-result-label">args</div>
            <pre className="tr-tool-args">{argsText}</pre>
          </>
        )}
        {result && (
          <>
            {result.textTruncated ? (
              <div className="tr-tool-result-label">
                result — spilled to artifact ({result.textBytes ? `${(result.textBytes / 1024).toFixed(1)}kB` : "large"})
              </div>
            ) : capturePath ? (
              <div className="tr-tool-result-label">screen capture</div>
            ) : text.length > 0 ? (
              <div className="tr-tool-result-label">result</div>
            ) : null}
            {capturePath && (
              <TuiCapture runId={runId} ansiPath={capturePath} />
            )}
            {!capturePath && text.length > 0 && !result.textTruncated && (
              <>
                <pre className="tr-tool-result">{shownText}</pre>
                {tooLong && (
                  <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--tr-teal)",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: "12px",
                      padding: "4px 0",
                    }}
                  >
                    {expanded ? "Show less" : `Show more (${text.length.toLocaleString()} chars)`}
                  </button>
                )}
              </>
            )}
            {result.image && (
              <div style={{ marginTop: "8px" }}>
                <Screenshot runId={runId} path={result.image} alt={`${call.name} screenshot`} />
              </div>
            )}
            {result.artifact && (
              <div style={{ marginTop: "8px" }}>
                <ArtifactChip
                  path={result.artifact}
                  active={result.artifact === activeArtifact}
                  onOpen={onOpenArtifact}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
