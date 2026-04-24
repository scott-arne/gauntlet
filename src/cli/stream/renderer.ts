/**
 * A structured entry as written to run.jsonl and delivered by
 * EvidenceLogger.addEventObserver. See src/evidence/logger.ts — we
 * mirror its shape verbatim and do not import its concrete types so
 * this module stays decoupled from the logger.
 */
export interface StreamEvent {
  eventId: number;
  parentEventId: number;
  ts: string;
  type: string;
  [k: string]: unknown;
}

export interface StreamRenderer {
  handle(event: StreamEvent): void;
  /** Flush any in-flight state (e.g. trailing newline, cleared spinner). */
  close(): void;
}
