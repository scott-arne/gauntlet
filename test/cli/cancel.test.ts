import { describe, test, expect, jest } from "bun:test";
import { installSigintHandler } from "../../src/cli/signals";

describe("installSigintHandler", () => {
  test("first invocation sets token.cancelled = true and returns detach", () => {
    const token = { cancelled: false };

    // Spy on process.on / process.removeListener
    const originalOn = process.on.bind(process);
    const originalRemove = process.removeListener.bind(process);
    const onSpy = jest.fn(originalOn);
    const removeSpy = jest.fn(originalRemove);
    process.on = onSpy as any;
    process.removeListener = removeSpy as any;

    try {
      const detach = installSigintHandler(token);
      expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));

      // Pull the registered handler and fire it
      const sigintCall = onSpy.mock.calls.find((c) => c[0] === "SIGINT");
      expect(sigintCall).toBeDefined();
      const handler = sigintCall![1] as () => void;

      // Suppress the stderr write during the test
      const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
      handler();
      expect(token.cancelled).toBe(true);
      stderrSpy.mockRestore();

      detach();
      expect(removeSpy).toHaveBeenCalledWith("SIGINT", handler);
    } finally {
      process.on = originalOn as any;
      process.removeListener = originalRemove as any;
    }
  });
});
