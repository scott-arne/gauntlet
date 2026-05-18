import { textResult, type ToolResult } from "../../../models/provider";
import { composeResult } from "../adapter";
import type { WebToolCtx } from "./types";

/**
 * Mouse-driven tools: click, double_click, right_click, hover, drag,
 * mouse_move, scroll.
 *
 * Action tools wrap their chrome-ws-lib call in try/catch so the
 * agent sees a clean "Error: …" tool result instead of a thrown
 * exception — a silent "clicked" when nothing actually got clicked
 * is a classic way to waste 40 turns. Each still issues the
 * return_screenshot capture regardless of action success/failure
 * (the post-error pixels are themselves a signal).
 */

export async function executeClick(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const result = await ctx.chrome.click(ctx.tab, args.selector as string);
    const note = result?.fallback ? ` (fallback: ${result.fallback})` : "";
    return composeResult(
      `clicked ${args.selector}${note}`,
      await ctx.takeReturnScreenshot(),
    );
  } catch (err) {
    // Make failures visible to the agent. A silent "clicked" when
    // nothing actually got clicked is a classic way to waste 40
    // turns.
    const reason = err instanceof Error ? err.message : String(err);
    return composeResult(`Error: ${reason}`, await ctx.takeReturnScreenshot());
  }
}

export async function executeHover(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    await ctx.chrome.hover(ctx.tab, args.selector as string);
    return composeResult(`hovered ${args.selector}`, await ctx.takeReturnScreenshot());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return composeResult(`Error: ${reason}`, await ctx.takeReturnScreenshot());
  }
}

export async function executeDoubleClick(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    await ctx.chrome.doubleClick(ctx.tab, args.selector as string);
    return composeResult(`double-clicked ${args.selector}`, await ctx.takeReturnScreenshot());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return composeResult(`Error: ${reason}`, await ctx.takeReturnScreenshot());
  }
}

export async function executeRightClick(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    await ctx.chrome.rightClick(ctx.tab, args.selector as string);
    return composeResult(`right-clicked ${args.selector}`, await ctx.takeReturnScreenshot());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return composeResult(`Error: ${reason}`, await ctx.takeReturnScreenshot());
  }
}

export async function executeDrag(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const sourceSelector = args.source_selector as string;
  const targetSelector = args.target_selector as string | undefined;
  const targetX = args.target_x as number | undefined;
  const targetY = args.target_y as number | undefined;
  // Agent supplies target_selector XOR (target_x AND target_y).
  // A real validation error — not something the lib will diagnose
  // helpfully — so catch it here with a pointer back to the schema.
  let target: string | { x: number; y: number };
  if (targetSelector) {
    target = targetSelector;
  } else if (typeof targetX === "number" && typeof targetY === "number") {
    target = { x: targetX, y: targetY };
  } else {
    return textResult(
      "Error: drag requires either target_selector or both target_x and target_y",
    );
  }
  try {
    await ctx.chrome.drag(ctx.tab, sourceSelector, target);
    return composeResult(`dragged ${sourceSelector}`, await ctx.takeReturnScreenshot());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return composeResult(`Error: ${reason}`, await ctx.takeReturnScreenshot());
  }
}

export async function executeMouseMove(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  await ctx.chrome.mouseMove(ctx.tab, args.x as number, args.y as number);
  return composeResult(
    `moved mouse to (${args.x}, ${args.y})`,
    await ctx.takeReturnScreenshot(),
  );
}

export async function executeScroll(
  ctx: WebToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const direction = args.direction as "up" | "down" | "left" | "right";
  const amount = (args.amount as number) ?? 300;
  // Map direction → wheel delta. Chrome's mouseWheel uses +y=down,
  // +x=right, which matches intuitive direction names.
  const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
  const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;
  await ctx.chrome.scroll(ctx.tab, {
    deltaX,
    deltaY,
    selector: (args.selector as string) ?? undefined,
  });
  return composeResult(`scrolled ${direction} ${amount}px`, await ctx.takeReturnScreenshot());
}
