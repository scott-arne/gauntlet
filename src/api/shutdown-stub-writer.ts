import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { VetResult } from "../types";
import { RESULT_SCHEMA_VERSION } from "../types";

/**
 * The floor-of-quality fallback for the shutdown drain story (PRI-1507):
 * when the post-abort patience window also expires with runs still in
 * flight, write a minimal `result.json` for each so `/api/results/:runId`
 * returns 200 with an errored manifest instead of 404 with an orphan dir.
 *
 * Race safety: writes ONLY if `result.json` does not already exist. The
 * only competing writer is the agent loop's success path
 * (`writeResultFiles` inside `executeRunCore`), which by spec §3's
 * ordering invariant runs BEFORE the wrapper's `afterClose` → registry
 * unregister. So a run still listed in the registry at stub time
 * provably has not yet written `result.json`.
 *
 * If the patience window happens to expire RIGHT as a slow agent loop
 * finishes — `writeResultFiles` between disk-flush and the
 * `afterClose`/unregister — the `existsSync` check will see the
 * real file and skip the stub. The narrow race that remains (file
 * created between the existsSync check and our writeFileSync) would
 * mean the real result.json gets overwritten by our stub, but only
 * if the agent's writeFileSync happens AFTER ours starts AND completes
 * BEFORE ours completes. `writeFileSync` is synchronous on the same
 * thread, so the window is microseconds — not zero, but small enough
 * to live with given the alternative (full atomic-rename plumbing).
 */
export interface StubTarget {
  runId: string;
  cardId: string;
  /** Used to derive `duration_ms`. `-1` sentinel if absent. */
  startedAt?: number;
}

export function writeShutdownStubs(
  targets: StubTarget[],
  resultsRoot: string,
): number {
  let written = 0;
  const now = Date.now();
  for (const t of targets) {
    const runDir = join(resultsRoot, t.runId);
    const stubPath = join(runDir, "result.json");
    if (existsSync(stubPath)) continue;
    // The run directory may not exist if the run never reached
    // `snapshotRunInputs` — defensively create it.
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    } else if (!existsSync(dirname(stubPath))) {
      mkdirSync(dirname(stubPath), { recursive: true });
    }

    const stub: VetResult = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      runId: t.runId,
      scenario: t.cardId,
      status: "errored",
      summary: "Run interrupted by shutdown signal (no record from agent)",
      reasoning:
        "Daemon shutdown grace window expired with this run still in flight, " +
        "and the agent loop did not write a result before the post-abort " +
        "patience window also expired.",
      observations: [],
      error: {
        type: "shutdown_interrupted",
        message: "interrupted by shutdown signal; no agent record",
      },
      evidence: { screenshots: [], log: "run.jsonl" },
      duration_ms: t.startedAt !== undefined ? now - t.startedAt : -1,
    };
    writeFileSync(stubPath, JSON.stringify(stub, null, 2));
    written++;
  }
  return written;
}
