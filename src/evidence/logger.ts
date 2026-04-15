import { mkdirSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";

export type BrowserEventCategory =
  | "console"
  | "exception"
  | "log"
  | "network-ws";

export class EvidenceLogger {
  private outDir: string;
  private screenshotCount = 0;
  private _screenshots: string[] = [];
  onAction?: (action: string, params: Record<string, unknown>) => void;

  constructor(outDir: string) {
    this.outDir = outDir;
    mkdirSync(join(outDir, "screenshots"), { recursive: true });
  }

  get screenshots(): string[] {
    return [...this._screenshots];
  }

  logAction(action: string, params: Record<string, unknown>): void {
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      params,
    };
    appendFileSync(
      join(this.outDir, "run.jsonl"),
      JSON.stringify(entry) + "\n"
    );
    this.onAction?.(action, params);
  }

  logBrowserEvent(
    category: BrowserEventCategory,
    data: Record<string, unknown>,
  ): void {
    const entry = {
      timestamp: new Date().toISOString(),
      category,
      ...data,
    };
    appendFileSync(
      join(this.outDir, `${category}.jsonl`),
      JSON.stringify(entry) + "\n",
    );
  }

  saveScreenshot(data: Buffer, name?: string): string {
    if (!name) {
      this.screenshotCount++;
      name = String(this.screenshotCount).padStart(3, "0");
    }
    const relativePath = `screenshots/${name}.png`;
    writeFileSync(join(this.outDir, relativePath), data);
    this._screenshots.push(relativePath);
    return relativePath;
  }

  get logPath(): string {
    return "run.jsonl";
  }
}
