import { readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ToolResult } from "../../../models/provider";
import { composeResult } from "../adapter";
import type { WebToolCtx } from "./types";

/**
 * Read-only DOM + pixel tools: screenshot, extract, wait_for.
 *
 * The screenshot path writes a tmp PNG, hands it to the logger to
 * persist into the run's artifacts, then unlinks (best-effort). The
 * extract path falls back to whole-page markdown when no selector
 * is supplied. wait_for accepts either selector or text; missing
 * both is a reportable error rather than an exception.
 */

export async function executeScreenshot(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tmpFile = join(tmpdir(), `gauntlet-screenshot-${Date.now()}.png`);
  await ctx.chrome.screenshot(
    ctx.tab,
    tmpFile,
    (args.selector as string) ?? null,
    (args.fullPage as boolean) ?? false,
  );
  const data = readFileSync(tmpFile);
  const saved = ctx.logger.saveScreenshot(Buffer.from(data));
  try {
    unlinkSync(tmpFile);
  } catch {
    // temp file cleanup is best-effort
  }
  return {
    text: `Screenshot saved to ${saved}`,
    image: { data: Buffer.from(data).toString("base64"), mediaType: "image/png" },
    imagePath: saved,
  };
}

export async function executeExtract(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const selector = args.selector as string | undefined;
  if (selector) {
    const text = await ctx.chrome.extractText(ctx.tab, selector);
    return { text };
  }
  // Return the full markdown inline so the model can read it. The
  // logger will spill to artifacts/N.txt for run.jsonl readability
  // when the text exceeds its inline limit, but that's a
  // reviewer-facing concern — the model has already consumed the
  // content by the time logging happens.
  const markdown = await ctx.chrome.generateMarkdown(ctx.tab);
  return { text: markdown };
}

export async function executeWaitFor(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const timeout = (args.timeout as number) ?? 5000;
  if (args.selector) {
    await ctx.chrome.waitForElement(ctx.tab, args.selector as string, timeout);
    return composeResult("element found", await ctx.takeReturnScreenshot());
  }
  if (args.text) {
    await ctx.chrome.waitForText(ctx.tab, args.text as string, timeout);
    return composeResult("text found", await ctx.takeReturnScreenshot());
  }
  return { text: "nothing to wait for — provide selector or text" };
}
