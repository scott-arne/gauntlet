# Gauntlet tutorial — same agent, three surfaces

A six-story walk through Gauntlet's three adapters: **CLI**,
**TUI**, and **Web**. Same agent at every level. The adapters
change what the agent looks at, not how it thinks.

Three things accumulate as we move through the tutorial:

- **Vision** — what the agent looks at. At the CLI level it is
  text prompts on stdout. At the TUI level it is ANSI: colors,
  cursor position, panels. At the Web level it is the DOM and
  pixel screenshots.
- **Reasoning** — multi-step navigation, search, edit, verify.
- **Context** — the `.gauntlet/context/` folder. Plain-language
  fixtures (a persona, sign-in instructions, content the agent
  has to read) that fill in details and inform choices.

Vision is the dimension that *graduates*. The other two are
present from the first story.

> **The trap to avoid.** Gauntlet stories describe **outcomes
> with conditions**. Not click sequences. Not selectors. The
> whole point of an LLM in the loop is that you don't write
> `click #submit-button` — the agent figures out the path.

You'll meet a character named **Fred** in tutorial 1 and stay
with him through tutorial 6. He's not alone in the context
tree — **Deborah** (Fred's friend, ancient vampire mentor) and
**Quinn** (Fred's nemesis) also have profiles. They demonstrate
the two sign-in mechanisms the Web tutorials cover:

- **Deborah** and **Quinn** sign in with **username and
  password** (their profiles have those fields, no cookies file).
- **Fred** signs in with **cookies** (a `cookies.yaml` lives
  next to his profile). Cookies are the fringe path — useful
  for testing, not normative for users — and tutorial 5 walks
  through why.

The cards refer to characters by name ("You are Fred") and
never tell the agent which file to read. That's deliberate.
The system prompt already enumerates the context tree as a
directory listing; the agent finds Fred by inference, the same
way a teammate would. The decoy profiles are how we tell
whether the agent really inferred or just used the only file
there.

Replace any of them with yourself any time you want; the agent
uses whoever's written into the relevant profile.

## Setup

Before you start, you need:

- `gauntlet` on your `$PATH` (see the [main README](../README.md)
  for install).
- An LLM API key in your environment
  (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`).
- Bun (the Web tutorials run a small local webapp — see
  tutorial 4).
- `tmux` (the TUI adapter runs terminal apps inside tmux).
- A copy of this folder. Run every command below from inside
  it:

```bash
cd examples/tutorial
```

Open `.gauntlet/context/` before you start. That's where Fred,
Deborah, and Quinn live — each as a `profile.md` under
`profiles/`, plus Fred's `cookies.yaml` for the cookie-based
sign-in story. Every story below leans on these files, and the
agent reads the tree the way a teammate would read a wiki.

Each tutorial below tells you which target tool (`npm`, `bun`,
`vim`, or a browser) it expects you to have.

---

## Tutorial 1 · CLI · `npm init`

The simplest version of Gauntlet. No screenshots, no rendered
screen — just a program asking for input on stdin and writing
to stdout. The agent's "vision" here is the most basic kind:
read what the program is asking for and decide what to send
back.

This is also the cleanest demonstration that **Gauntlet is not
expect**. We do not write a script of inputs in order. We tell
the agent: *create a package.json for Fred; fill in author from
the profile; accept sensible defaults.* The agent reads each
prompt as it comes and answers in turn. If npm changes its
question order tomorrow, the story still works.

### The card

[`.gauntlet/stories/01-npm-init.md`](../examples/tutorial/.gauntlet/stories/01-npm-init.md).
Read it before running. Notice what's *not* there: the prompts
npm asks (name, version, description, entry point, …) are not
enumerated. The card describes the goal; the agent works out
the prompts.

### Run it

```bash
gauntlet run .gauntlet/stories/01-npm-init.md \
  --adapter cli \
  --target "mkdir -p scratch-npm && cd scratch-npm && npm init" \
  --turns 30
```

`--target` here is **a shell command**, not a URL. The CLI
adapter spawns `sh -c "<target>"` and connects the agent to its
stdin/stdout.

The scratch dir matters: `npm init` writes `package.json` into
the current directory, and we don't want it landing on top of
the tutorial fixtures. Each setup-creating story uses its own
`scratch-<tool>/` subdirectory (gitignored). Delete those dirs
to reset.

### What to notice

- The author field on the proposed `package.json` contains
  Fred's name. The card never said "use `profiles/fred/profile.md`" —
  the agent enumerated the context tree, saw three profiles
  (Fred, Deborah, Quinn), and picked Fred's because the card
  says "You are Fred." That inference is the test.
- The agent did *not* pre-decide the prompt order. It read
  each question as npm asked it and answered.
- Try changing the card to say "You are Deborah" and re-run.
  The author field changes — without you touching any profile
  file or the run command. That's context-as-fixture working
  at the lowest-vision setting.

---

## Tutorial 2 · TUI · `bun init`

Now the agent has eyes — at least the kind that read ANSI.
`bun init` opens an arrow-key selector with three template
options, each rendered in a different color. The currently-
highlighted option is **yellow with an underline**; the others
are cyan and blue.

This is Vision emerging at its first level: *color is
information*. The agent isn't supposed to figure out the
selection by counting position. It's supposed to *see* the
yellow underline.

### The card

[`.gauntlet/stories/02-bun-init.md`](../examples/tutorial/.gauntlet/stories/02-bun-init.md).
Profile says Fred prefers the `Library` template. After Library
is selected, `bun init` follows up with a text prompt — *package
name* — that the agent has to answer. (Decoy profiles say
otherwise: Deborah prefers Blank, Quinn prefers React. If the
agent picks the wrong profile, you will see it.)

### Run it

```bash
gauntlet run .gauntlet/stories/02-bun-init.md \
  --adapter tui \
  --target "mkdir -p scratch-bun && cd scratch-bun && bun init" \
  --turns 30
```

Same scratch-dir pattern as tutorial 1.

For TUI runs, Gauntlet starts a detached `tmux` session at
120×40 and runs the target command inside it. Keystrokes go to
that session with `tmux send-keys`; `read_screen` uses
`tmux capture-pane -p -e` to read the rendered screen with ANSI
escapes preserved. The agent gets that raw ANSI and parses the
colors itself.

### What to notice

In the run's transcript, the agent should *cite colors* in its
reasoning — something like "the highlighted option is rendered
in yellow with an underline (`\x1b[4m\x1b[33mLibrary\x1b[0m`)."
That's the agent literally reading affordance, not guessing
from position.

A few variations worth trying:

- Swap the card to say "You are Quinn." The agent should pick
  React, then navigate the *second* arrow-key selector that
  appears (Default / TailwindCSS / Shadcn) — a more demanding
  Vision test that uses two highlights in a row.
- Change Fred's preferred template in `profile.md` and re-run
  *without* touching the card. The choice should follow.
- Delete one of the decoy profiles and re-run. The agent's
  reasoning should still be correct, but it gets there by less
  inference work — which is exactly why the decoys are there.

---

## Tutorial 3 · TUI · vim with splits and search

The full-strength TUI showcase. Vision / Reasoning / Context
all flexing at the same time, before Web complications enter
the picture.

What's new at this level:

- **Vision at full TUI strength.** The agent verifies syntax
  highlighting is working — that markdown headings show up
  styled against plain text in `notes.md`, and that TypeScript
  keywords (`import`, `export`, `interface`, `async`) get
  distinct colors in `setup.ts`.
- **Reasoning over panes.** The agent splits the window
  (`:sp setup.ts`), navigates between panes with `Ctrl+W`, and
  searches with `/`.
- **Context for content.** The card asks the agent to find
  *Fred's preferred blood type for casual feeding*. That
  information is in `notes.md`, **not** in the profile. The
  agent has to know what to look for, where to look, and
  report what it finds.

### The card

[`.gauntlet/stories/03-vim-split.md`](../examples/tutorial/.gauntlet/stories/03-vim-split.md).

### Run it

```bash
gauntlet run .gauntlet/stories/03-vim-split.md \
  --adapter tui \
  --target "vim -u ./vimrc notes.md" \
  --turns 50
```

### What to notice

- The agent's reasoning trace cites *specific colors* for
  markdown headings and TypeScript keywords — evidence it was
  reading the rendered screen, not bluffing.
- The reported blood type matches `AB-` (or whatever you set
  in `notes.md`). Change `notes.md` to mention a different
  preference and re-run; the report changes.
- The agent saved and quit cleanly with `:wqa`.

If syntax highlighting *fails* — older vim, weird terminal —
the agent should report that as a failed acceptance criterion,
not silently pass. The test makes a broken environment visible
instead of letting it slide.

---

## Tutorial 4 · Web · Sign in with username and password (Deborah)

The first tutorial that runs against a real web app. Not a
deployed one — the tutorial ships a small Bun server in
`examples/tutorial/webapp/` for the Web stories to test
against. Three pre-seeded users. Deborah's profile carries a
username and password; the agent has to find the sign-in form,
type the credentials, and submit. This is the normative path
— what most apps look like to most users.

The Web pillar is mostly about the third dimension finally
showing up at full strength: the agent has DOM, layout,
pixels, multiple pages, forms. The mechanics of *finding* a
sign-in page and *filling* a form are exactly what the agent
already knows how to do — there is no `install_credentials`
analog to `install_cookies`, because there does not need to
be. The profile supplies the values; the regular browser
tools do the rest.

### Setup: start the webapp

```bash
bun webapp/server.ts
```

Leave it running on port `4444`. Restart it whenever you want
a clean slate (sessions, posts are all in process memory).

### The card

[`.gauntlet/stories/04-login-credentials.md`](../examples/tutorial/.gauntlet/stories/04-login-credentials.md).

### Run it

```bash
gauntlet run .gauntlet/stories/04-login-credentials.md \
  --adapter web \
  --target "http://localhost:4444" \
  --turns 50
```

The webapp's sign-in form lives at `/login`. The agent
discovers it by following the "sign in" link from the home
page — the same way a human would.

### What to notice

- The agent *reads Deborah's profile* and pulls username +
  password out of it. The card never named the profile path.
- After submit, the post-sign-in screenshot shows `@deborah`
  in the nav. The agent did **not** click logout.
- Try changing the password in `profile.md` to a wrong value
  and re-run — the agent should fail the run, not silently
  pass.

---

## Tutorial 5 · Web · Sign in with cookies (Fred)

A different auth path against the same target. Fred's profile
has a `cookies.yaml` instead of a password. Gauntlet's
`install_cookies` tool reads it and registers the session
directly with the browser, bypassing the sign-in form
entirely.

This is the *fringe but useful* path. Real users never sign in
this way — but as a tester, sometimes you have a session
cookie in hand and want to skip past the sign-in flow to
focus on what comes after. `install_cookies` is the lever for
that.

The teaching points are:

- `install_cookies` does what its name says.
- The cookie lifecycle has a quirk: Gauntlet's first navigate
  happens *before* any tool runs, so a cookie installed
  afterward needs a fresh page load to apply.
- The agent finds the right cookie file by inference. With
  the card pinned to Fred, it picks Fred's `cookies.yaml`.

### The card

[`.gauntlet/stories/05-login-cookies.md`](../examples/tutorial/.gauntlet/stories/05-login-cookies.md).

### Run it

```bash
gauntlet run .gauntlet/stories/05-login-cookies.md \
  --adapter web \
  --target "http://localhost:4444" \
  --turns 50
```

### What to notice

- The pre-cookie screenshot shows the signed-out homepage —
  no profile menu, just a "not signed in" nav with a sign-in
  link.
- After `install_cookies`, the agent navigates again. This is
  the lifecycle quirk `credentials.md` calls out: cookies
  installed after Gauntlet's initial navigate need a fresh
  page load to apply.
- The post-navigation screenshot shows `@fred` in the nav and
  a logout link the agent did **not** click.

---

## Tutorial 6 · Web · Friends-only post + cross-identity check

Everything from tutorials 4 and 5, plus a stricter test: the
agent posts as one identity, then **switches to a different
identity** and verifies the visibility rules actually hold.
The two identities use different sign-in mechanisms — Fred via
cookies, Quinn via username and password — so this story
exercises both paths in one run.

This is where every pillar earns its keep:

- **Vision** — the friends-only badge on the saved post is a
  visual signal. The "Not a friend" relation on Fred's profile
  is too. The agent confirms both via screenshot.
- **Reasoning** — sign in (cookies), compose, post, sign in
  again (form), navigate to Fred's profile, verify the post
  is hidden.
- **Context** — both Fred's and Quinn's profiles are picked
  out of the tree by inference. Fred has cookies; Quinn has a
  password. The agent uses each in its own way.

The webapp's friend graph is hardcoded:

- Fred ↔ Deborah are friends.
- Quinn is alone — no friends, by design.

So Fred's friends-only post is visible to Deborah and to Fred
himself, and **not** visible to Quinn. The story tests that
last invariant.

### The card

[`.gauntlet/stories/06-post-and-verify.md`](../examples/tutorial/.gauntlet/stories/06-post-and-verify.md).

### Run it

```bash
gauntlet run .gauntlet/stories/06-post-and-verify.md \
  --adapter web \
  --target "http://localhost:4444" \
  --turns 80
```

The bigger turn budget reflects the cross-identity flow.

### What to notice

- A friends-only post exists on Fred's profile after the first
  half of the run.
- After signing in as Quinn (form-based) and navigating to
  Fred's profile, the relation reads "Not a friend."
- The friends-only post is **not** visible. The load-bearing
  acceptance criterion is exactly this — if the post is
  visible to a non-friend, the run fails.

---

## Where to go from here

You now have:

- A `.gauntlet/context/` tree with three personas and content
  fixtures.
- Six working stories spanning all three adapters.
- A small local webapp that demonstrates cookie-based auth,
  username+password auth, and friend-graph-driven visibility.
- A felt sense for what Vision / Reasoning / Context look like
  at each level.

Before any of that, open the most recent `result.json` under
`.gauntlet/results/`. The agent reports observations alongside
its verdict — `bug`, `ux`, `typo`, `a11y`, `suggestion`,
`performance`. None of the cards above asked for those; the
agent surfaces them anyway. Read them as starting points, not
verdicts. Sometimes the agent is just filling space; sometimes
it caught the thing your suite didn't think to check.

Three good next moves:

1. **Write a story for your own app.** Copy a card, change the
   persona to yourself, point `--target` at your app. Iterate
   by editing the card.
2. **Try `gauntlet fanout`.** It generates variations from a
   parent card — edge cases, error paths, alternate personas.
   Useful when you have one good card and want a small suite.
3. **Try `gauntlet batch`.** Run several stories in one go:
   `gauntlet batch .gauntlet/stories/04-login-credentials.md
   .gauntlet/stories/05-login-cookies.md
   .gauntlet/stories/06-post-and-verify.md --target
   http://localhost:4444`. The live ticker is satisfying.

When the agent gets confused, the fix is almost always a
sentence in a `.md` file, not a code change. Edit. Re-run.
That's the loop.
