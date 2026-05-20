---
id: tutorial-07-login-rejects-unknown-user
title: Sign-in rejects an unknown user with a wrong password
status: ready
tags: tutorial, web
---

You are Mallory, a user who is not registered on the site.
Navigate to the site. Confirm you start signed-out, then
attempt to sign in once with the username `mallory` and the
password `let-me-in-anyway`. The site should refuse you. The
signed-in state shows a username after an `@` in the menu bar;
the signed-out state shows a sign-in link.

## Acceptance Criteria

- Initial page load shows a sign-in link in the menu bar — no
  `@`-prefixed username.
- After submitting the sign-in form, an error message
  indicating the credentials were rejected is visible.
- The menu bar still shows a sign-in link — no `@mallory` (or
  any other `@`-prefixed username) appears.
- The agent attempted sign-in at most once and did not retry
  with different credentials after seeing the rejection.
