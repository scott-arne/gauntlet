import { describe, test, expect } from "bun:test";
import { RunBroadcaster } from "../../src/api/ws";

describe("RunBroadcaster", () => {
  test("broadcasts messages to all connected clients", () => {
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

  test("different run IDs are isolated", () => {
    const broadcaster = new RunBroadcaster();
    const received: string[] = [];

    const ws1 = { send: (d: string) => received.push(`1:${d}`), readyState: 1 };
    const ws2 = { send: (d: string) => received.push(`2:${d}`), readyState: 1 };

    broadcaster.addClient("run-a", ws1 as any);
    broadcaster.addClient("run-b", ws2 as any);

    broadcaster.send("run-a", { type: "frame", data: "abc" });

    expect(received).toEqual(['1:{"type":"frame","data":"abc"}']);
  });
});
