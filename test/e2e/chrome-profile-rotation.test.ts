import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// PRI-1280 regression: within a single process (as in `gauntlet serve`),
// successive startChrome calls with different profile names must launch
// Chrome against different --user-data-dirs. Before the fix, the module
// cached the first run's dir and reused it for every later run, leaking
// cookies across scenarios.
describe("chrome profile rotation (PRI-1280)", () => {
  const originalXdg = process.env.XDG_CACHE_HOME;
  const cacheRoot = mkdtempSync(join(tmpdir(), "gauntlet-profile-rotation-"));

  beforeAll(() => {
    process.env.XDG_CACHE_HOME = cacheRoot;
  });

  afterAll(() => {
    if (originalXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdg;
    try {
      rmSync(cacheRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test(
    "two startChrome calls with different profile names use different user-data-dirs",
    async () => {
      // PRI-1436: chrome-ws-lib's only top-level export is now createSession().
      // The rotation invariant — successive startChrome calls with different
      // profile names use different --user-data-dirs — must hold within a
      // single session (same WebAdapter, multiple runs).
      let chrome: any;
      try {
        const { createSession } = require("../../src/adapters/web/lib/chrome-ws-lib");
        chrome = createSession();
      } catch {
        console.log("Skipping: chrome-ws-lib not available");
        return;
      }

      const profileA = "gauntlet-run-rotation-a";
      const profileB = "gauntlet-run-rotation-b";
      const dirA = chrome.getChromeProfileDir(profileA);
      const dirB = chrome.getChromeProfileDir(profileB);
      expect(dirA).not.toBe(dirB);

      try {
        await chrome.startChrome(true, profileA);
        const statusA = await chrome.getBrowserMode();
        expect(statusA.profileDir).toBe(dirA);
        // Chrome populates the profile dir on first launch (Preferences,
        // First Run, etc.). Non-empty => Chrome actually used this dir.
        expect(existsSync(dirA)).toBe(true);
        expect(readdirSync(dirA).length).toBeGreaterThan(0);

        await chrome.killChrome();

        await chrome.startChrome(true, profileB);
        const statusB = await chrome.getBrowserMode();
        // The regression would leave profileDir pointing at dirA here.
        expect(statusB.profileDir).toBe(dirB);
        expect(existsSync(dirB)).toBe(true);
        expect(readdirSync(dirB).length).toBeGreaterThan(0);
      } finally {
        try {
          await chrome.killChrome();
        } catch {
          // best-effort
        }
        // Reset module-level profile name so subsequent tests in the
        // same process don't inherit our rotation-b profile in their logs.
        try {
          chrome.setProfileName("superpowers-chrome");
        } catch {
          // best-effort
        }
      }
    },
    60_000,
  );
});
