import { Hono } from "hono";

export type ErrorSource = "run" | "fanout";

export interface ErrorEntry {
  timestamp: string;
  source: ErrorSource;
  message: string;
}

export class ErrorLog {
  private buffer: ErrorEntry[] = [];
  private capacity: number;

  constructor(capacity = 50) {
    this.capacity = capacity;
  }

  add(source: ErrorSource, message: string) {
    this.buffer.push({
      timestamp: new Date().toISOString(),
      source,
      message,
    });
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
  }

  entries(): ErrorEntry[] {
    return [...this.buffer].reverse();
  }

  count(): number {
    return this.buffer.length;
  }
}

export function errorRoutes(log: ErrorLog) {
  const router = new Hono();

  router.get("/", (c) => {
    return c.json({ errors: log.entries() });
  });

  return router;
}
