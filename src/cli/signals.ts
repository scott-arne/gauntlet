// src/cli/signals.ts
import type { CancelToken } from "../runs/run-set";

export function installSigintHandler(token: CancelToken): () => void {
  let firedOnce = false;
  let firedAt = 0;

  const handler = () => {
    const now = Date.now();
    if (firedOnce && now - firedAt < 2000) {
      // Hard exit
      process.stderr.write("\nReceived second SIGINT, forcing exit.\n");
      process.exit(130);
    }
    firedOnce = true;
    firedAt = now;
    token.cancelled = true;
    process.stderr.write("\nReceived SIGINT, cancelling… (Ctrl-C again to force exit)\n");
  };

  process.on("SIGINT", handler);
  return () => process.removeListener("SIGINT", handler);
}
