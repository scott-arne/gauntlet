import { readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { EvidenceLogger } from "../../../evidence/logger";
import type { ChromeSession, ScreenshotResult } from "../adapter";

// Hard cap on how long a `return_screenshot` capture is allowed to take.
// The pre-fix observed failure mode was a 30s hang when the capture was
// issued mid-navigation; this cap turns that into a fast skip-with-reason
// instead (see PRI-1517).
const RETURN_SCREENSHOT_TIMEOUT_MS = 5000;

/**
 * Build the per-call `takeReturnScreenshot` closure that wraps the
 * dispatch site's tab + return_screenshot flag. The closure is a
 * no-op when `args.return_screenshot` is falsy, captures a PNG via
 * chrome.screenshot otherwise, persists it through the logger, and
 * cleans the tmp file. Failures (mid-nav, CDP timeouts) become a
 * fast skip-with-reason rather than a thrown exception.
 */
export function buildReturnScreenshot(opts: {
  chrome: ChromeSession;
  defaultTab: string | number;
  logger: EvidenceLogger;
  toolName: string;
  args: Record<string, unknown>;
}): (tabOverride?: string | number) => Promise<ScreenshotResult> {
  const { chrome, defaultTab, logger, toolName, args } = opts;
  return async (tabOverride?: string | number): Promise<ScreenshotResult> => {
    if (!args.return_screenshot) return {};
    const targetTab = tabOverride ?? defaultTab;
    const t0 = Date.now();
    const tmpFile = join(tmpdir(), `gauntlet-screenshot-${Date.now()}.png`);
    try {
      await chrome.screenshot(targetTab, tmpFile, null, false, {
        timeoutMs: RETURN_SCREENSHOT_TIMEOUT_MS,
      });
      const data = readFileSync(tmpFile);
      const imagePath = logger.saveScreenshot(Buffer.from(data));
      try {
        unlinkSync(tmpFile);
      } catch {
        /* best-effort */
      }
      return {
        image: { data: Buffer.from(data).toString("base64"), mediaType: "image/png" },
        imagePath,
      };
    } catch (err) {
      try {
        unlinkSync(tmpFile);
      } catch {
        /* best-effort */
      }
      const reason = err instanceof Error ? err.message : String(err);
      const elapsed = Date.now() - t0;
      console.warn(
        `[gauntlet] return_screenshot skipped (${toolName}, ${elapsed}ms): ${reason}`,
      );
      return { screenshotSkipped: reason };
    }
  };
}
