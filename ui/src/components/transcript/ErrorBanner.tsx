import type { SoftErrorSite } from "../../lib/transcript";

interface Props {
  sites: SoftErrorSite[];
}

// Banner at the top of the transcript that indexes the run's soft-error
// sites — places where the agent's tool call succeeded but returned an
// error message, typically causing it to spend extra turns recovering.
// Each entry jumps to the turn via the anchor id set on TurnBlock.
//
// The UI surfaces "here's where the run got stuck"; the human decides the
// category (Gauntlet tool ergonomics, system prompt, story setup) from
// reading the tool + arguments + error text in the linked turn.
export function ErrorBanner({ sites }: Props) {
  if (sites.length === 0) return null;

  return (
    <aside className="tr-error-banner" role="note" aria-label="Recoverable errors">
      <div className="tr-error-banner-head">
        <span className="tr-error-banner-count">{sites.length}</span>
        <span className="tr-error-banner-label">
          recoverable error{sites.length === 1 ? "" : "s"} — spots worth reviewing
        </span>
      </div>
      <ul className="tr-error-banner-list">
        {sites.map((s) => (
          <li key={`${s.turn}-${s.toolUseId}`}>
            <a href={`#turn-${s.turn}`} onClick={(e) => handleJump(e, s.turn)}>
              <span className="tr-error-banner-turn">Turn {s.turn}</span>
              <span className="tr-error-banner-tool">{s.toolName}</span>
              <span className="tr-error-banner-snippet">{s.snippet}</span>
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function handleJump(e: React.MouseEvent<HTMLAnchorElement>, turn: number) {
  // Prevent native jump so we can do a smooth scroll that works inside the
  // <main> scroll container (AppShell's .flex-1.overflow-y-auto).
  e.preventDefault();
  const target = document.getElementById(`turn-${turn}`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  // Brief visual tap so the user knows where they landed.
  target.classList.add("tr-flash");
  setTimeout(() => target.classList.remove("tr-flash"), 1200);
}
