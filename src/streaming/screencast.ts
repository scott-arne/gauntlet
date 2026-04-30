// PRI-1436: chrome-ws-lib is now a per-session factory. The screencast must
// share the WebAdapter's session (so it talks to the same Chrome on the same
// activePort), so callers pass in a session via setChromeSession() before
// start(). The fallback fresh-session is only used by tests that construct
// a streamer but never call start() — the session has no work to do until
// start() pulls tabs.
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSession } = require("../adapters/web/lib/chrome-ws-lib") as {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createSession: (opts?: { host?: string; port?: number }) => Record<string, any>;
};

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
    saveDir?: string,
    chromeSession?: ChromeSession,
  ) {
    this.tabIndex = tabIndex;
    this.onFrame = onFrame;
    this.saveDir = saveDir;
    // PRI-1436: prefer the caller-provided session (the WebAdapter's). Fall
    // back to a fresh session for legacy callers; that session won't see the
    // adapter's Chrome process but is fine for construction-only tests.
    this.chrome = chromeSession ?? createSession();
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
