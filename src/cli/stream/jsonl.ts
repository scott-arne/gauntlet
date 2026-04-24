import type { StreamEvent, StreamRenderer } from "./renderer";

export interface WriteSink {
  write(s: string): void;
}

export class JsonlRenderer implements StreamRenderer {
  constructor(private sink: WriteSink) {}

  handle(event: StreamEvent): void {
    this.sink.write(JSON.stringify(event) + "\n");
  }

  close(): void {
    // nothing to flush — each handle() already wrote a complete line
  }
}
