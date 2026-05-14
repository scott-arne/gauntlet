import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { buildReflectionReminder } from "../../src/agent/reflection";
import { isSystemReminder } from "../../ui/src/lib/transcript-blocks";

// PRI-1495 — the UI's SystemReminderPanel selection depends on user_message
// content matching /^\s*<SYSTEM-REMINDER>/. If a future edit re-words the
// prefix in reflection.ts or agent.ts, these tests fail loudly instead of
// letting the UI silently fall back to UserMessagePanel.
describe("system-reminder prefix coupling", () => {
  test("buildReflectionReminder() output matches the UI's reminder regex", () => {
    const out = buildReflectionReminder('  1. click(selector=".btn")');
    expect(isSystemReminder(out)).toBe(true);
  });

  test("the grace-turn reminder literal in agent.ts opens with <SYSTEM-REMINDER>", () => {
    const agentSrc = readFileSync(
      join(import.meta.dir, "..", "..", "src", "agent", "agent.ts"),
      "utf8",
    );
    expect(agentSrc).toMatch(/`<SYSTEM-REMINDER>\\n`/);
  });
});
