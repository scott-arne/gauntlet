export type StreamFormat = "pretty" | "jsonl";

export interface StreamOptionsInput {
  isTTY: boolean;
  env: Record<string, string | undefined>;
  silent: boolean;
  format: StreamFormat | undefined;
  noColor: boolean;
  columns: number;
}

export interface StreamOptions {
  silent: boolean;
  format: StreamFormat;
  color: boolean;
  columns: number;
}

export function resolveStreamOptions(input: StreamOptionsInput): StreamOptions {
  const format: StreamFormat = input.format ?? (input.isTTY ? "pretty" : "jsonl");
  const noColorEnv = input.env.NO_COLOR !== undefined && input.env.NO_COLOR !== "";
  const color = !input.noColor && !noColorEnv && input.isTTY;
  return {
    silent: input.silent,
    format,
    color,
    columns: input.columns,
  };
}
