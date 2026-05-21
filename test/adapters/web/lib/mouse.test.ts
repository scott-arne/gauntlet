import { describe, test, expect } from "bun:test";

const { attachMouse } = require("../../../../src/adapters/web/lib/mouse.js");

interface SendCall {
  method: string;
  params: Record<string, unknown>;
}

interface FakeHandlers {
  [method: string]: (params: Record<string, unknown>) => unknown;
}

function makeFakePageSession(handlers: FakeHandlers): {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  calls: SendCall[];
} {
  const calls: SendCall[] = [];
  return {
    calls,
    async send(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      const handler = handlers[method];
      if (handler) return handler(params);
      return { result: { value: undefined } };
    },
  };
}

function setup(handlers: FakeHandlers = {}) {
  const ps = makeFakePageSession({
    "Runtime.evaluate": () => ({ result: { value: { found: true, x: 100, y: 200 } } }),
    "Input.dispatchMouseEvent": () => ({}),
    ...handlers,
  });
  return {
    ...attachMouse({ getPageSession: async () => ps }),
    ps,
  };
}

describe("mouse.click", () => {
  test("throws when selector matches no element (no silent success)", async () => {
    // Both resolveCenter AND the fallback see the element as missing.
    // The function must propagate that as an error rather than returning
    // { clicked: true, fallback: true } — that lies to the caller.
    const { click } = setup({
      "Runtime.evaluate": () => ({ result: { value: { found: false } } }),
    });
    await expect(click(0, "#nonexistent")).rejects.toThrow(/not found/i);
  });

  test("falls back to el.click() when CDP coord resolution throws but element exists", async () => {
    let callCount = 0;
    const { click, ps } = setup({
      "Runtime.evaluate": () => {
        callCount++;
        // 1st call: resolveCenter — return found:false so it throws.
        // 2nd call: fallback IIFE — return found:true so click succeeds.
        return { result: { value: { found: callCount === 1 ? false : true } } };
      },
    });
    const result = await click(0, "#hidden-but-exists");
    expect(result.fallback).toBe(true);
    const evals = ps.calls.filter((c) => c.method === "Runtime.evaluate");
    expect(evals.length).toBe(2);
  });

  test("sends mousePressed + mouseReleased at the resolved center on the happy path", async () => {
    const { click, ps } = setup();
    await click(0, "#button");
    const mouseCalls = ps.calls.filter((c) => c.method === "Input.dispatchMouseEvent");
    expect(mouseCalls.length).toBe(2);
    expect(mouseCalls[0].params.type).toBe("mousePressed");
    expect(mouseCalls[1].params.type).toBe("mouseReleased");
    expect(mouseCalls[0].params.x).toBe(100);
    expect(mouseCalls[0].params.y).toBe(200);
  });
});
