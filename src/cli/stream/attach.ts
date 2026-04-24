import type { EvidenceLogger } from "../../evidence/logger";
import type { StreamOptions } from "./format";
import type { StreamRenderer } from "./renderer";
import { JsonlRenderer, type WriteSink } from "./jsonl";
import { PrettyRenderer } from "./pretty";

/**
 * Attach a stream renderer to an EvidenceLogger's event observer channel.
 * Returns a cleanup function that detaches the observer and flushes the
 * renderer. Callers should invoke cleanup exactly once, typically in a
 * finally block alongside adapter.close().
 */
export function attachRenderer(
  logger: EvidenceLogger,
  opts: StreamOptions,
  sink: WriteSink,
): () => void {
  if (opts.silent) return () => {};
  const renderer: StreamRenderer =
    opts.format === "jsonl"
      ? new JsonlRenderer(sink)
      : new PrettyRenderer(sink, { color: opts.color, columns: opts.columns });

  const unsubscribe = logger.addEventObserver((ev) => {
    renderer.handle(ev as any);
  });

  return () => {
    unsubscribe();
    renderer.close();
  };
}
