const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

export type Paint = {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  blue: (s: string) => string;
  magenta: (s: string) => string;
  cyan: (s: string) => string;
};

export function makePaint(enabled: boolean): Paint {
  if (!enabled) {
    const id = (s: string) => s;
    return { bold: id, dim: id, red: id, green: id, yellow: id, blue: id, magenta: id, cyan: id };
  }
  const wrap = (code: string) => (s: string) => `${code}${s}${CODES.reset}`;
  return {
    bold: wrap(CODES.bold),
    dim: wrap(CODES.dim),
    red: wrap(CODES.red),
    green: wrap(CODES.green),
    yellow: wrap(CODES.yellow),
    blue: wrap(CODES.blue),
    magenta: wrap(CODES.magenta),
    cyan: wrap(CODES.cyan),
  };
}
