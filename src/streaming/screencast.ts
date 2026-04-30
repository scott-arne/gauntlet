// PRI-1436: chrome-ws-lib is now a per-session factory. The screencast must
// share the WebAdapter's session (so it talks to the same Chrome on the same
// activePort), so the session is a required constructor argument. Constructing
// a streamer without one was previously possible via a fresh-session fallback;
// that fallback was a footgun (the fresh session has no Chrome behind it) so
// callers must now pass the WebAdapter's session explicitly.
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface ScreencastFrame {
  data: string; // base64 jpeg
  metadata: { width: number; height: number };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChromeSession = Record<string, any>;

export class ScreencastStreamer {
  private running = false;
  private onFrame: (frame: ScreencastFrame) => void;
  private tabIndex: number;
  private saveDir?: string;
  private frameCount = 0;
  private chrome: ChromeSession;

  constructor(
    tabIndex: number,
    onFrame: (frame: ScreencastFrame) => void,
    chromeSession: ChromeSession,
    saveDir?: string,
  ) {
    this.tabIndex = tabIndex;
    this.onFrame = onFrame;
    this.saveDir = saveDir;
    // PRI-1436: required — must be the WebAdapter's session so the streamer
    // talks to the same Chrome the adapter started.
    this.chrome = chromeSession;
    if (saveDir) {
      mkdirSync(saveDir, { recursive: true });
    }
  }

  async start(options?: {
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
  }) {
    this.running = true;

    const tabs = await this.chrome.getTabs();
    if (!tabs[this.tabIndex]) throw new Error(`Tab ${this.tabIndex} not found`);
    const wsUrl = tabs[this.tabIndex].webSocketDebuggerUrl;

    await this.chrome.onCdpEvent(this.tabIndex, async (event: any) => {
      if (!this.running) return;
      if (event.method !== "Page.screencastFrame") return;

      const params = event.params;
      this.onFrame({
        data: params.data,
        metadata: {
          width: params.metadata?.deviceWidth || 0,
          height: params.metadata?.deviceHeight || 0,
        },
      });

      if (this.saveDir) {
        const filename = `frame-${String(this.frameCount).padStart(5, "0")}.jpg`;
        writeFileSync(join(this.saveDir, filename), Buffer.from(params.data, "base64"));
        this.frameCount++;
      }

      // Acknowledge frame so Chrome sends the next one
      await this.chrome.sendCdpCommand(wsUrl, "Page.screencastFrameAck", {
        sessionId: params.sessionId,
      });
    });

    // Defaults tuned for local dev: Gauntlet runs on the developer's
    // machine, not over a network, so CPU-to-encode is the only cost of
    // higher quality. JPEG quality 70 at 1280×720 (CDP's stock "streaming"
    // setting) produced visible compression artifacts and downscaling
    // blur in the LiveRun pane; 92 at 1920×1200 is effectively lossless
    // and accommodates the 1440×900 default viewport without scaling.
    // Revisit if Gauntlet ever runs against a remote Chrome where
    // bandwidth matters.
    await this.chrome.sendCdpCommand(wsUrl, "Page.startScreencast", {
      format: "jpeg",
      quality: options?.quality ?? 92,
      maxWidth: options?.maxWidth ?? 1920,
      maxHeight: options?.maxHeight ?? 1200,
      everyNthFrame: 2,
    });
  }

  async stop() {
    this.running = false;
    try {
      const tabs = await this.chrome.getTabs();
      if (tabs[this.tabIndex]) {
        const wsUrl = tabs[this.tabIndex].webSocketDebuggerUrl;
        await this.chrome.sendCdpCommand(wsUrl, "Page.stopScreencast");
      }
      await this.chrome.offCdpEvent(this.tabIndex);
    } catch {
      // Ignore errors during cleanup
    }
  }
}
