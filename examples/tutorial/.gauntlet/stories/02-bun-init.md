---
id: tutorial-02-bun-init
title: Initialize a Bun project with Fred's preferred template
status: ready
tags: tutorial, tui
---

You are Fred. Run `bun init`. It opens an arrow-key selector
with three template options: Blank, React, Library. The
currently-highlighted option is rendered in **yellow with an
underline**; the others are in cyan and blue.

Pick the template Fred prefers. Use the visual cue (the
yellow underline) — not just position — to confirm which
option is selected before pressing Enter.

After the template is chosen, bun init asks for a package
name. Provide one that fits Fred's client-ledger work.

## Acceptance Criteria

- The selected option matched Fred's preferred template
- A package name was supplied (not just an empty Enter)
- bun init completed and the project files were written
- The reasoning summary cites the ANSI styling observed for
  the highlighted option
