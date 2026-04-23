export const MIME_TYPES: Record<string, string> = {
  html: "text/html",
  js: "application/javascript",
  css: "text/css",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  webm: "video/webm",
  webp: "image/webp",
  mp4: "video/mp4",
  // Raw TUI capture (ANSI-annotated text). Served as plain text so
  // browsers show the escape sequences verbatim — the parsed `.json`
  // twin is what the UI actually renders.
  ansi: "text/plain; charset=utf-8",
};

export function getMimeType(ext: string): string {
  return MIME_TYPES[ext] || "application/octet-stream";
}
