---
id: tutorial-03-vim-split
title: Split panes in vim, verify highlighting, and find Fred's preferred blood type
status: ready
tags: tutorial, tui
---

You are Fred. Open `notes.md`.  Verify that markdown
syntax highlighting is active — heading lines and list items
should appear in distinct colors against the background, not
plain white-on-black.

Open `setup.ts` in a horizontal split (`:sp setup.ts`).
Confirm TypeScript syntax highlighting works in the new pane:
keywords like `import`, `export`, `interface`, and `async`
should each be styled.

Switch back to `notes.md`. Find the line that names Fred's
**preferred blood type for casual feeding** and report what
it says.

When done, write and quit both panes (`:wqa`).

## Acceptance Criteria

- Markdown syntax highlighting is visible in `notes.md`
  (heading lines styled distinctly)
- TypeScript syntax highlighting is visible in `setup.ts`
  (keywords styled distinctly)
- The reported blood type matches what is written in `notes.md`
- Vim exited cleanly (you see the parent shell prompt or the
  session terminates)
- Cite specific ANSI color codes you observed for at least
  one markdown heading and one TypeScript keyword
