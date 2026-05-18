export type ErrorSource = "run" | "fanout" | "cards";

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
