import type { EvidenceLogger } from "../../../evidence/logger";
import type { ChromeSession, ScreenshotResult } from "../adapter";

/**
 * Per-call context threaded to every per-tool execute function.
 *
 * `tab` is the active tab (top of the WebAdapter's focus stack at
 * dispatch time, or numeric 0 fallback). `takeReturnScreenshot` is
 * the closure built once per executeTool() call so it can capture
 * the args.return_screenshot flag — it accepts an optional tab
 * override for the new_tab / close_tab paths where the focus moved
 * before screenshot time.
 */
export interface WebToolCtx {
  chrome: ChromeSession;
  tab: string | number;
  logger: EvidenceLogger;
  takeReturnScreenshot: (tabOverride?: string | number) => Promise<ScreenshotResult>;
}
