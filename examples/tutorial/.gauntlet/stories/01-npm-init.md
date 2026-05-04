---
id: tutorial-01-npm-init
title: Create a package.json with npm init
status: ready
tags: tutorial, cli
---

You are Fred. Run `npm init` and answer the prompts to create
a new `package.json`. The package is for Fred's client-ledger
work — pick a sensible package name and a one-line description
that fits.

Set the author field appropriately. Accept defaults for fields
that don't matter. When npm prints the proposed JSON and asks
"Is this OK?", confirm.

## Acceptance Criteria

- npm init completed without an error
- The proposed `package.json` was confirmed (npm did not
  cancel)
- The author field on the proposed JSON contains Fred's name
