import { describe, test, expect } from "bun:test";
import { ErrorLog, errorRoutes } from "../../src/api/routes/errors";
import { Hono } from "hono";

describe("ErrorLog", () => {
  test("stores errors up to capacity", () => {
    const log = new ErrorLog(3);
    log.add("run", "Something broke");
    log.add("fanout", "Parse failed");
    log.add("run", "Timeout");

    expect(log.entries()).toHaveLength(3);
  });

  test("evicts oldest entries when full", () => {
    const log = new ErrorLog(2);
    log.add("run", "first");
    log.add("run", "second");
    log.add("run", "third");

    const entries = log.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe("third");
    expect(entries[1].message).toBe("second");
  });

  test("entries are returned newest-first", () => {
    const log = new ErrorLog();
    log.add("run", "old");
    log.add("fanout", "new");

    const entries = log.entries();
    expect(entries[0].message).toBe("new");
    expect(entries[0].source).toBe("fanout");
  });

  test("entries include timestamp", () => {
    const log = new ErrorLog();
    log.add("run", "test");

    const entry = log.entries()[0];
    expect(typeof entry.timestamp).toBe("string");
    expect(new Date(entry.timestamp).getTime()).not.toBeNaN();
  });
});

describe("Error API", () => {
  test("GET /api/errors returns error entries", async () => {
    const log = new ErrorLog();
    log.add("run", "Something broke");

    const app = new Hono();
    app.route("/api/errors", errorRoutes(log));

    const res = await app.request("/api/errors");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].message).toBe("Something broke");
    expect(body.errors[0].source).toBe("run");
  });

  test("GET /api/errors returns empty array when no errors", async () => {
    const log = new ErrorLog();
    const app = new Hono();
    app.route("/api/errors", errorRoutes(log));

    const res = await app.request("/api/errors");
    const body = await res.json();
    expect(body.errors).toEqual([]);
  });
});
