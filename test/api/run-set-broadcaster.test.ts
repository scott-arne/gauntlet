import { describe, test, expect } from "bun:test";
import { RunSetBroadcaster } from "../../src/api/run-set-broadcaster";

class FakeWs {
  readyState = 1;
  sent: string[] = [];
  send(msg: string) { this.sent.push(msg); }
}

describe("RunSetBroadcaster", () => {
  test("send dispatches to all clients subscribed to that runSetId", () => {
    const b = new RunSetBroadcaster();
    const ws1 = new FakeWs();
    const ws2 = new FakeWs();
    const ws3 = new FakeWs();
    b.addClient("set-A", ws1 as any);
    b.addClient("set-A", ws2 as any);
    b.addClient("set-B", ws3 as any);
    b.send("set-A", { kind: "pass_start", attemptNumber: 1 });
    expect(ws1.sent).toHaveLength(1);
    expect(ws2.sent).toHaveLength(1);
    expect(ws3.sent).toHaveLength(0);
    expect(JSON.parse(ws1.sent[0])).toEqual({ kind: "pass_start", attemptNumber: 1 });
  });

  test("removeClient stops further dispatch to that ws", () => {
    const b = new RunSetBroadcaster();
    const ws = new FakeWs();
    b.addClient("set-A", ws as any);
    b.removeClient("set-A", ws as any);
    b.send("set-A", { kind: "set_done" });
    expect(ws.sent).toHaveLength(0);
  });

  test("send skips ws with readyState !== 1", () => {
    const b = new RunSetBroadcaster();
    const ws = new FakeWs();
    ws.readyState = 3;
    b.addClient("set-A", ws as any);
    b.send("set-A", { kind: "set_done" });
    expect(ws.sent).toHaveLength(0);
  });
});
