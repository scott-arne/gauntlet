# Gauntlet Profiles — Specification

**Status:** Draft for review.

---

## The one-sentence summary

A profile is a markdown file the agent can read on demand via a `read_profile` tool. The system prompt lists which profiles are available; the agent calls the tool to pull a profile's body — character context and credentials — into its context only when the story needs that identity. From there the agent uses the existing browser tools to log in.

## Problem

Gauntlet runs a card against an unauthenticated browser. Many real stories — privacy, multi-user collaboration, role-based access, anything behind a login — need authenticated sessions, and some need more than one identity in the same run. There is no way to express any of this today. The agent boots into a logged-out browser and either gives up or improvises.

## Goals

A developer with a real app and a real dev database can test a multi-user story in **fifteen minutes**, without changing the application under test.

Concretely:

- A profile is one markdown file. One new tool. No new commands. No new schemas.
- Cards do not need to change to use profiles — once profiles exist in the project, the agent has the keychain available automatically.
- Existing cards keep working unchanged.
- Multi-profile stories let the agent decide when to switch identities, using the same browser tools it already has.
- The feature works against any login flow the agent can complete by typing into a form: username/password, simple email-code, anything that boils down to "fill fields, click submit."

## Non-goals

Out of scope for v1:

- Pre-injecting captured sessions via CDP.
- Provisioning ephemeral users or managing server-side state.
- A dev-only endpoint on the application under test.
- Profile encryption, secret vaults, integration with credential managers.
- Non-browser adapters (TUI, CLI). The profile concept is adapter-agnostic in shape; the v1 implementation only consumes profiles in the web adapter.
- Any opinion about how test accounts come to exist in the database in the first place.

## A note on the shape

This spec picks lazy loading over eager loading deliberately, and it's an experiment worth being honest about. The simpler design — splice every profile body into the system prompt at turn 0 — would also work, with less code and one fewer tool call per identity switch. We're picking the lazy version because we want to learn whether agent-driven discovery works well enough in practice: does the agent reliably call `read_profile` when the card mentions a name? Does it forget? Does it hallucinate aliases? Does the extra turn matter? If the answer is "this works fine," we keep it and the design scales naturally to projects with many profiles. If the answer is "the agent flakes on it," we fall back to eager-loading the keychain into the system prompt — a small, well-understood change.

## The day-one flow

```
$ cat my-project/profiles/alice.md
---
display_name: Alice Chen
---

A privacy-conscious blogger with a small friend list. Writes 2–3 posts a
week about cooking. Careful about what she shares publicly.

## Credentials

- Username: alice@example.com
- Password: hunter2

$ cat my-project/profiles/bob.md
---
display_name: Bob Wilson
---

A casual reader. Not on Alice's friends list.

## Credentials

- Username: bob@example.com
- Password: hunter3

$ cat my-project/stories/privacy-001.md
---
id: privacy-001
title: Alice's posts only visible to friends
---

Alice publishes a post with "friends only" visibility. Bob, who is not on
her friends list, then tries to find it via search and in the feed.

## Acceptance Criteria
- Privacy level is clearly indicated at post time
- The post's distribution is clearly indicated after posting
- The post doesn't appear in search for bob
- The post doesn't appear in bob's feed

$ gauntlet run my-project/stories/privacy-001.md --target http://localhost:3000
[agent reads alice's profile, logs in, posts, logs out, reads bob's profile,
 logs in as bob, checks visibility]
```

Three files. One run. Zero changes to the app under test. Zero changes to the card schema.

---

## Design

### Project layout

```
my-project/
  stories/
  results/
  profiles/                   NEW
    alice.md
    bob.md
```

The `profiles/` directory parallels `stories/`. Filenames without extension are profile aliases — `profiles/alice.md` is the profile `alice`. No separate catalog file. The directory listing *is* the catalog.

### Profile file format

A profile is a markdown file with optional frontmatter and a body. The body is freeform prose. Credentials live in the body, not the frontmatter.

```markdown
---
display_name: Alice Chen          # optional; falls back to the alias
tags: [blogger, verified]         # optional; for filtering/future tooling
---

A privacy-conscious blogger with a small friend list. Writes 2–3 posts a
week about cooking. Cares deeply about who can see her posts.

## Credentials

- Username: alice@example.com
- Password: hunter2
```

**Frontmatter.** Two optional fields:

| Field | Required | Description |
|---|---|---|
| `display_name` | no | Human-readable name. Defaults to the alias (filename). Surfaced in the system prompt's profile list so the agent can match card prose ("log in as Alice Chen") to the right alias. |
| `tags` | no | Comma-separated labels. Not load-bearing today; kept for parity with story cards. |

**Body.** The body is freeform markdown prose. Gauntlet does not parse it into a schema — the `read_profile` tool returns it verbatim. Two conventions help the agent:

1. A short character description in the first paragraph or two. This shapes the agent's perspective: who is this person, what do they care about, how should they behave?
2. A `## Credentials` section with a bulleted list of whatever the login flow needs — username, password, sometimes a second factor or a one-time code. The agent uses its existing `navigate`/`type`/`click` tools to act on whatever you put there. Don't include a login URL: finding the login page is the agent's job.

Neither convention is enforced. Profiles can be any shape that's useful.

We don't yet know whether profile files will mostly be hand-written or produced by some kind of generator script. Both work, the format is simple enough for either, and we'll learn more once people actually use it.

### Runner behavior

The `run` CLI grows one step between "parse the card" and "start the adapter":

1. If `<project-dir>/profiles/` does not exist or is empty, skip profile loading. Run proceeds with no keychain.
2. Otherwise, read every `*.md` file in `profiles/`, parse frontmatter and body, and collect them into a profile table keyed by alias.
3. Pass the profile table to the `WebAdapter` constructor.
4. Pass the *aliases and display names* (not bodies) to `buildSystemPrompt` so it can list them in the prompt.
5. Proceed with the existing adapter start + agent loop.

Failures in profile parsing abort the run before LLM tokens are spent, with a specific error naming the bad file.

The web adapter holds the profile table for the lifetime of the run and serves bodies on demand via the new tool. Profile bodies are *not* in the system prompt — only the alias list is.

### The `read_profile` tool

`WebAdapter.toolDefinitions()` registers a new tool when one or more profiles are loaded. If the profile table is empty, the tool is not registered.

```typescript
{
  name: "read_profile",
  description:
    "Read the full content of a profile from your keychain — character " +
    "context and login credentials. You must call this tool to learn a " +
    "profile's credentials before you can log in as that user. Profiles " +
    "are listed by alias in the system prompt; pass the alias to retrieve " +
    "the body.",
  parameters: {
    type: "object",
    properties: {
      alias: {
        type: "string",
        description: "The profile alias to read. Must be one listed in the system prompt.",
        enum: [/* loaded profile aliases, populated at registration time */]
      }
    },
    required: ["alias"]
  }
}
```

**Implementation:** look up the alias in the profile table. If found, return the body verbatim as a `ToolResult` text. If not found, return an error result naming the alias and listing the available ones (the agent will see it as a tool result and may retry or give up).

The tool is read-only and has no side effects on the browser. It's information transfer, nothing more. The browser only changes when the agent uses `navigate`/`type`/`click` to act on the credentials it just read.

### System prompt augmentation

`buildSystemPrompt` (`src/agent/prompts.ts`) grows a "Keychain" section, appended only when one or more profiles are loaded. It lists aliases and display names, but **not** bodies.

```
## Keychain

The following profiles are available for this run. Each represents a test
user with credentials. To access a profile's credentials and character
context, call the `read_profile` tool with the profile's alias. You must
read a profile before you can log in as that user.

To switch identities mid-run, log out, then read the new profile and log
back in.

- alice (Alice Chen)
- bob (Bob Wilson)
```

When a profile has no `display_name`, render the alias alone — no trailing parenthetical.

The agent reads the card body, sees a reference like "log in as Alice" or "act as alice," matches the name to the keychain list, calls `read_profile("alice")`, receives the credentials in a tool result, and proceeds to log in using the existing browser tools.

### Writing multi-profile cards: the narrative carries the order

Authors do not need any special syntax to tell the agent which criterion belongs to which profile. They name the profile in the criterion prose — "doesn't appear in search for bob" — and the agent matches the name against the keychain.

The part that is genuinely hard is **causal ordering**, and the natural place to express it is the card's body. The agent reads the body as a procedure.

Two styles both work:

**Narrative style (terse):**

```markdown
---
id: privacy-001
title: Alice's posts only visible to friends
---

Alice publishes a post with "friends only" visibility. Bob, who is not on
her friends list, then tries to find it via search and in the feed.

## Acceptance Criteria
- The post doesn't appear in search for bob
- The post doesn't appear in bob's feed
```

Two sentences in the body do most of the ordering work. The agent reads "Alice publishes... Bob then tries..." and the order is obvious.

**Procedural style (explicit):**

```markdown
---
id: privacy-001
title: Alice's posts only visible to friends
---

Verify that a friends-only post is not visible to non-friends.

## What to Test

1. Read alice's profile from your keychain.
2. Log in as alice using her credentials.
3. Navigate to the posting interface.
4. Write a short post with privacy level set to "friends only."
5. Submit the post and confirm it appears.
6. Note the post URL.
7. Log out.
8. Read bob's profile from your keychain.
9. Log in as bob.
10. Navigate to the URL from step 6. Confirm you cannot see the post.
11. Go to the feed and confirm the post is not there.
12. Search for a distinctive word from the post. Confirm no results.
13. Log out.

## Acceptance Criteria
- The post doesn't appear in search for bob
- The post doesn't appear in bob's feed
```

This is basically a test script. Less inference required, more determinism, more words to write. Note the explicit "Read alice's profile" steps: in the procedural style, the author can spell out exactly when to call `read_profile`. In the narrative style, the agent infers it from the prose — "Alice publishes" implies "read alice's profile, then log in as her, then post."

Both styles are correct. Smoke tests want the terse style; critical regressions want the procedural one.

---

## Implementation surface

| File | Change |
|---|---|
| `src/format/profile.ts` | **NEW.** Load a profile markdown file, parse frontmatter and body, return `{alias, display_name, tags, body}`. |
| `src/cli/run.ts` | Read `profiles/*.md` from the project directory; pass the profile table into `WebAdapter`; pass alias/display-name list into `buildSystemPrompt`. |
| `src/adapters/web/adapter.ts` | Constructor accepts an optional profile table; `toolDefinitions()` conditionally adds `read_profile`; `executeTool` handles it. |
| `src/agent/prompts.ts` | Append the Keychain section listing aliases and display names when profiles are loaded. |

**Test surface:**

- Profile loader rejects unparseable files with a clear error naming the file.
- Profile loader returns frontmatter (`display_name`, `tags`) and body verbatim.
- `WebAdapter.toolDefinitions()` includes `read_profile` when profiles are loaded and omits it otherwise.
- `read_profile` returns the body for a known alias and an error for an unknown one.
- `buildSystemPrompt` includes the Keychain section listing aliases when profiles are loaded.
- Smoke test against a tiny Express app with two seeded users — the Alice-and-Bob privacy story end-to-end. Verify the agent calls `read_profile` before each login.

No new commands. No card schema change. The only new agent tool is `read_profile`. The web adapter constructor grows one optional argument; everything else is wiring.

---

## Behavior when things go wrong

| Situation | Behavior |
|---|---|
| `profiles/` does not exist or is empty | Run proceeds without a keychain. `read_profile` is not registered. Existing behavior preserved. |
| A profile markdown file fails to parse | Abort. Error names the file and the parse error. |
| Agent calls `read_profile` with an unknown alias | Tool returns an error string naming the alias and listing valid aliases. The agent sees it and may retry or give up. |
| Agent forgets to call `read_profile` and tries to log in with hallucinated credentials | The login fails at the credentials step. Probably reported as `fail` or `investigate`. This is the failure mode we're explicitly testing for — if it happens often, the lazy-loading shape isn't working and we should fall back to eager-loading. |
| Credentials are present but the agent fails to log in (wrong field selectors, captcha, slow page) | The run proceeds and the agent will probably fail or report `investigate`. Known limitation of agent-driven login, unrelated to profiles. |

---

## Security notes

Be honest about the threat model.

Profile files sit on the local disk and hold the credentials of test accounts on a development or staging database. The same credentials reach several places during a run:

- The `read_profile` tool result, which lands in the message stream as an assistant-visible response.
- The LLM provider's request logs (Anthropic / OpenAI retention policies apply) on every subsequent turn that includes the message stream.
- The action log written by `EvidenceLogger`: `read_profile` tool calls and their results are recorded, and every subsequent `type` tool call records its text argument (the typed password).
- Potentially in screenshots, depending on how the app's password field renders during typing. Most apps mask with bullets; some briefly show plaintext.

None of this is specific to profiles — Gauntlet already writes evidence files that can contain anything the agent saw or typed. Profiles don't widen the surface; they just make the credentials predictable.

The lazy-loading shape gives a small win over eager-loading: if the agent never calls `read_profile` for a given identity (because the card doesn't need it), that profile's credentials never enter the message stream at all. With eager loading, every profile's credentials would be in the system prompt on every turn whether the run used them or not.

**Use throwaway credentials.** The single most important rule. Profile credentials should be test accounts on a dev or staging database, created for the purpose of being poked at by a robot. Never production accounts. Never a password anyone has used anywhere else.

`profiles/` should probably be gitignored by default — it holds credentials, and keeping it out of source control matches how `results/` and `evidence/` already work. The runner can write a `profiles/.gitignore` the first time it touches the directory.

---

## Summary

| Question | Answer |
|---|---|
| Where do credentials live? | In the body of a markdown file under `profiles/<alias>.md`. |
| How does the agent get them? | It calls the `read_profile` tool with the alias, and the tool returns the body. |
| How does the agent know which profiles exist? | The system prompt lists their aliases and display names under a "Keychain" section. |
| How does the agent know which profile to use? | The card body names the profile in prose ("log in as alice"). The agent matches the name against the keychain list, calls `read_profile`, and proceeds. |
| How does the agent log in? | Existing browser tools: `navigate`, `type`, `click`. The credentials come from the `read_profile` tool result. |
| How does multi-profile work? | The agent logs out, reads the next profile from the keychain, and logs back in. No switching primitive. |
| Who manages server state? | The user, by hand. Gauntlet does not touch the database. |
| What does the app under test have to change? | **Nothing.** |
| What does the card schema have to change? | **Nothing.** |
| What are the open security caveats? | Credentials appear in the message stream after `read_profile`, in LLM provider logs, in action logs, and possibly in screenshots. Use throwaway test credentials only. |

Four files touched, one new file, one new agent tool, no new commands, no card schema change, no adapter interface change.
