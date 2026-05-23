import { RunDetail } from "./RunDetail";
import { TranscriptView } from "./transcript";

/**
 * Renders a self-contained run report from the static payload injected at
 * build time. Composes RunDetail (status/summary/observations/evidence) and
 * TranscriptView into a single page for offline/static use.
 *
 * Data source: window.__GAUNTLET_RUN__ (set by the HTML generator).
 */
export function StaticRunPage() {
  const payload =
    typeof window !== "undefined" ? window.__GAUNTLET_RUN__ : undefined;

  if (!payload) {
    return (
      <div className="p-6 text-slate">
        No run data found. (window.__GAUNTLET_RUN__ is missing.)
      </div>
    );
  }

  const noop = () => {};

  return (
    <div className="static-run-report">
      <RunDetail result={payload.result} onFanout={noop} onRunAgain={noop} />
      <hr className="my-6 border-slate-300" />
      <section className="px-6 pb-6">
        <h2 className="text-lg font-semibold mb-2">Transcript</h2>
        <TranscriptView mode="posthoc" runId={payload.result.runId} />
      </section>
    </div>
  );
}
