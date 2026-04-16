import { describe, test, expect } from "bun:test";
import { RunBroadcaster } from "../../src/api/ws";

// The broadcaster is keyed by runId — distinct runs of the same card
// receive distinct channels, no interleaving.
describe("RunBroadcaster", () => {
  test("broadcasts messages to all connected clients on a runId channel", () => {
    const broadcaster = new RunBroadcaster();
    const received: string[] = [];

    const fakeWs1 = {
      send: (data: string) => received.push(`ws1:${data}`),
      readyState: 1,
    };
    const fakeWs2 = {
      send: (data: string) => received.push(`ws2:${data}`),
      readyState: 1,
    };

    broadcaster.addClient("run-1", fakeWs1 as any);
    broadcaster.addClient("run-1", fakeWs2 as any);

    broadcaster.send("run-1", { type: "progress", message: "hello" });

    expect(received).toEqual([
      'ws1:{"type":"progress","message":"hello"}',
      'ws2:{"type":"progress","message":"hello"}',
    ]);
  });

  test("removes closed clients", () => {
    const broadcaster = new RunBroadcaster();
    const received: string[] = [];

    const fakeWs = {
      send: (data: string) => received.push(data),
      readyState: 3,
    };

    broadcaster.addClient("run-1", fakeWs as any);
    broadcaster.send("run-1", { type: "progress", message: "hello" });

    expect(received).toEqual([]);
  });

  test("different runIds are isolated channels", () => {
    const broadcaster = new RunBroadcaster();
    const received: string[] = [];

    const ws1 = { send: (d: string) => received.push(`1:${d}`), readyState: 1 };
    const ws2 = { send: (d: string) => received.push(`2:${d}`), readyState: 1 };

    broadcaster.addClient("run-a", ws1 as any);
    broadcaster.addClient("run-b", ws2 as any);

    broadcaster.send("run-a", { type: "frame", data: "abc" });

    expect(received).toEqual(['1:{"type":"frame","data":"abc"}']);
  });

  test("two concurrent runs of the same card use distinct runId channels", () => {
    // The whole point of runId-as-key: two runs against the same card
    // must not see each other's frames.
    const broadcaster = new RunBroadcaster();
    const a: string[] = [];
    const b: string[] = [];
    const wsA = { send: (d: string) => a.push(d), readyState: 1 };
    const wsB = { send: (d: string) => b.push(d), readyState: 1 };

    broadcaster.addClient("login-001_20260416T142301Z_k3xm", wsA as any);
    broadcaster.addClient("login-001_20260416T142302Z_qq8a", wsB as any);

    broadcaster.send("login-001_20260416T142301Z_k3xm", { type: "frame", data: "A" });
    broadcaster.send("login-001_20260416T142302Z_qq8a", { type: "frame", data: "B" });

    expect(a).toEqual(['{"type":"frame","data":"A"}']);
    expect(b).toEqual(['{"type":"frame","data":"B"}']);
  });
});
