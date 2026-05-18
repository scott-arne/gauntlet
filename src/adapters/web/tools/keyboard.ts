import type { ToolResult } from "../../../models/provider";
import { composeResult } from "../adapter";
import type { WebToolCtx } from "./types";

/**
 * Keyboard tools: type, press.
 *
 * `type` with a selector clicks-then-fills; without a selector it
 * walks the text character by character through keyboardPress so
 * each char fires a real keydown/keyup. `press` is the single-key
 * path for Enter, Tab, arrow keys, etc.
 */

export async function executeType(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const selector = args.selector as string | undefined;
  const text = args.text as string;
  if (selector) {
    await ctx.chrome.fill(ctx.tab, selector, text);
  } else {
    // No selector — type via keyboard
    for (const char of text) {
      await ctx.chrome.keyboardPress(ctx.tab, char);
    }
  }
  return composeResult("typed", await ctx.takeReturnScreenshot());
}

export async function executePress(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  await ctx.chrome.keyboardPress(ctx.tab, args.key as string);
  return composeResult("pressed", await ctx.takeReturnScreenshot());
}
