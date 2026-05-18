import type { ToolResult } from "../../../models/provider";
import { composeResult } from "../adapter";
import type { WebToolCtx } from "./types";

/**
 * Page-level action tools: navigate, eval, file_upload.
 *
 * `eval` stays implemented but is not exposed in the schema
 * (PRI-1590 experiment — see tool-defs.ts). file_upload routes to
 * DOM.setFileInputFiles via chrome.fileUpload — the only way to
 * programmatically set <input type=file>.
 */

export async function executeNavigate(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  await ctx.chrome.navigate(ctx.tab, args.url as string);
  return composeResult("navigated", await ctx.takeReturnScreenshot());
}

export async function executeEval(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const result = await ctx.chrome.evaluate(ctx.tab, args.expression as string);
  const text =
    result === undefined
      ? "undefined"
      : typeof result === "string"
        ? result
        : JSON.stringify(result);
  return composeResult(text, await ctx.takeReturnScreenshot());
}

export async function executeFileUpload(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const result = await ctx.chrome.fileUpload(
      ctx.tab,
      args.selector as string,
      args.file_paths as string[],
    );
    return composeResult(
      `uploaded ${result.files} file(s) to ${args.selector}`,
      await ctx.takeReturnScreenshot(),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return composeResult(`Error: ${reason}`, await ctx.takeReturnScreenshot());
  }
}
