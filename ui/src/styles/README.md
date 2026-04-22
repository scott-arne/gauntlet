# ui/src/styles

Scoped to the transcript components; all classes prefixed `.tr-` to avoid Tailwind collisions. Imported by `TranscriptView.tsx`, not by `main.tsx`, so styles are tree-shaken out of routes that don't use them.
