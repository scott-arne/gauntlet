import { describe, test, expect } from "bun:test";
import { serve, type WsLike } from "../../src/runtime/serve";

function freePort(): number {
  // 40000-49999 is unprivileged + uncrowded; the test always binds with
  // SO_REUSEADDR off, so a busy-loop here is unnecessary in practice.
  return 40000 + Math.floor(Math.random() * 10000);
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
  });
}

describe("runtime/serve", () => {
  test("HTTP fetch roundtrip", async () => {
    const port = freePort();
    const server = serve({
      port,
      fetch: () => new Response("hello"),
    });
    try {
      const res = await fetch(`http://localhost:${port}/`);
      expect(await res.text()).toBe("hello");
    } finally {
      await server.stop();
    }
  });

  test("WebSocket upgrade fires open and close hooks with upgrade data", async () => {
    const port = freePort();
    const events: string[] = [];

    const server = serve<{ runId: string }>({
      port,
      fetch: () => new Response("not ws"),
      websocket: {
        upgrade: (url) => {
          if (url.pathname !== "/api/ws") return null;
          return { runId: url.searchParams.get("run") ?? "" };
        },
        open: (ws: WsLike, data) => {
          events.push(`open:${data.runId}`);
          ws.send(`ack:${data.runId}`);
        },
        close: (_ws, data) => {
          events.push(`close:${data.runId}`);
        },
      },
    });

    try {
      const ws = new WebSocket(`ws://localhost:${port}/api/ws?run=abc`);
      const message = await new Promise<string>((resolve, reject) => {
        ws.addEventListener("message", (ev) => resolve(String(ev.data)), { once: true });
        ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
      });
      expect(message).toBe("ack:abc");
      ws.close();

      // wait for close hook
      const deadline = Date.now() + 2000;
      while (!events.includes("close:abc") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(events).toContain("open:abc");
      expect(events).toContain("close:abc");
    } finally {
      await server.stop();
    }
  });

  test("WebSocket upgrade rejection falls through to fetch", async () => {
    const port = freePort();
    const server = serve({
      port,
      fetch: () => new Response("from-fetch"),
      websocket: {
        upgrade: () => null,
        open: () => {},
        close: () => {},
      },
    });
    try {
      const res = await fetch(`http://localhost:${port}/anything`);
      expect(await res.text()).toBe("from-fetch");
    } finally {
      await server.stop();
    }
  });
});
