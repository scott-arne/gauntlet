import { textResult, type ToolResult } from "../../../models/provider";
import { composeResult } from "../adapter";
import type { WebToolCtx } from "./types";

/**
 * Side-trip tab tools: new_tab, close_tab (PRI-1439).
 *
 * Tab tools mutate the adapter's focus stack — bottom is the
 * original tab opened during start(); each new_tab pushes, each
 * close_tab pops. The top of the stack is the active tab — its
 * wsUrl is passed to every chrome-ws-lib dispatch. These tools take
 * a WebTabsCtx that exposes the stack and a recomputeActiveTab()
 * helper so the return_screenshot capture hits the now-active tab,
 * not the one we just left/closed.
 */

// PRI-1439: cap on side-trip nesting depth. 1 = original tab only;
// each `new_tab` pushes; each `close_tab` pops. Typical use is 1–2 levels
// (signin → email; signin → password manager → 2FA portal). The cap is
// a guardrail against runaway tab creation, not a tuning knob.
export const MAX_TAB_DEPTH = 5;

export interface WebTabsCtx extends WebToolCtx {
  tabStack: Array<{ wsUrl: string; url: string }>;
  recomputeActiveTab: () => string | number;
}

export async function executeNewTab(
  ctx: WebTabsCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // The cap is on total stack depth (1 original + N side trips).
  // Frame the user-facing error in side-trip terms so the agent
  // can plan against the number it cares about.
  if (ctx.tabStack.length >= MAX_TAB_DEPTH) {
    return textResult(
      `Error: too many side-trip tabs (max ${MAX_TAB_DEPTH - 1}; ` +
        `close one with close_tab before opening another)`,
    );
  }
  const targetUrl = args.url as string | undefined;
  // Empty / non-http URLs would otherwise become about:blank and
  // silently consume a stack slot — refuse explicitly so the
  // agent doesn't waste turns.
  if (
    typeof targetUrl !== "string" ||
    !/^(https?:|file:|about:)/i.test(targetUrl)
  ) {
    return textResult(
      "Error: new_tab requires an absolute URL (http://, https://, " +
        "file://, or about:)",
    );
  }
  try {
    const created = await ctx.chrome.newTab(targetUrl);
    const wsUrl = created?.webSocketDebuggerUrl as string | undefined;
    if (!wsUrl) {
      return textResult("Error: chrome did not return a tab WebSocket URL");
    }
    ctx.tabStack.push({ wsUrl, url: targetUrl });
    ctx.logger.logEvent("tab_focus_changed", {
      action: "push",
      depth: ctx.tabStack.length,
      ws_url: wsUrl,
      url: targetUrl,
    });
    // Recompute against the now-pushed tab so return_screenshot
    // captures the *new* tab, not the one we just left.
    const newActive = ctx.recomputeActiveTab();
    return composeResult(
      `opened tab (depth ${ctx.tabStack.length})`,
      await ctx.takeReturnScreenshot(newActive),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return textResult(`Error: ${reason}`);
  }
}

export async function executeCloseTab(
  ctx: WebTabsCtx,
  _args: Record<string, unknown>,
): Promise<ToolResult> {
  if (ctx.tabStack.length <= 1) {
    return textResult(
      "Error: cannot close the original tab — use navigate to change the page",
    );
  }
  const popped = ctx.tabStack.pop()!;
  ctx.logger.logEvent("tab_focus_changed", {
    action: "pop",
    depth: ctx.tabStack.length,
    ws_url: popped.wsUrl,
    url: popped.url,
  });
  let closeWarning = "";
  try {
    await ctx.chrome.closeTab(popped.wsUrl);
  } catch (err) {
    // Surface the chrome-side failure so the agent knows the tab
    // *might* still exist in Chrome (its stack-mutation already
    // happened — focus has moved). Worst case the orphan is GC'd
    // when the run ends.
    const reason = err instanceof Error ? err.message : String(err);
    closeWarning = ` (warning: chrome closeTab failed — ${reason})`;
    ctx.logger.logEvent("tab_force_close_failed", {
      ws_url: popped.wsUrl,
      url: popped.url,
      reason,
    });
  }
  // Same fix as new_tab: return_screenshot must hit the *now-active*
  // tab (the one we popped back to), not the just-closed tab.
  const newActive = ctx.recomputeActiveTab();
  return composeResult(
    `closed tab (depth ${ctx.tabStack.length})${closeWarning}`,
    await ctx.takeReturnScreenshot(newActive),
  );
}
